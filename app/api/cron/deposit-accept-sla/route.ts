// app/api/cron/deposit-accept-sla/route.ts
//
// Flawless-handoff (2026-06-27): SLA safety-net for paid deposits the rancher
// hasn't accepted.
//
// The worst silent failure on the platform: a buyer pays a deposit, is waiting
// for a call, and the rancher never taps "Accept Slot" — so the deal rots. The
// instant notify (lib/rancherNotify, fired from settleBuyerDeposit) is the
// first touch; this cron is the backstop. Hourly, it finds deposits paid >N
// hours ago with no Rancher Accepted At, RE-PINGS the rancher (same email +
// SMS), and escalates an admin Telegram to Ben.
//
// Idempotent: stamps `Rancher Re-pinged At` and dedupes on it (selectSlaEligible
// skips anything re-pinged within the cooldown), so re-running the hourly cron
// re-pings each stuck deposit at most ~once/day — and at most 3 times TOTAL
// (email-hygiene 2026-08-02: the re-ping window closes at slaHours + 3×cooldown,
// derived purely from Deposit Paid At; after 72h the rancher goes quiet and a
// one-shot loud operator escalation takes over — see the escalation pass below).
//
// Mirrors awaiting-payment-nudge: CRON_SECRET auth wrapper + withCronRun +
// maintenance gate + throttle-stamp-BEFORE-side-effect ordering.
//
// TELL THE BUYER (Wave 2 buyer-comms, 2026-08-01 — GTM plan 2.3): until now
// this cron re-pinged the RANCHER and Telegram'd the operator while the buyer
// — the person told "usually the same day" and the only one whose money was
// standing still — heard NOTHING, ever. The $50 shop rail already tells its
// buyer (product-fulfillment-sla → sendBuyerOrderDelayNotice); this is the
// $2,000 rail's mirror: sendBuyerDepositDelayNotice, ONE per referral ever,
// once the deposit has sat unaccepted past BUYER_DELAY_HOURS. Referrals has
// no free field for a stamp (no new Airtable fields), so the one-shot
// throttle is a Redis claimOnce with a ~1yr TTL — same pattern as the
// settlement rails. claimOnce degrades open only when Redis is entirely
// absent (local dev); a claim is taken BEFORE the send so retries/crashes
// cannot double-mail.
//
// CONNECT RAIL ONLY, for the re-ping half (broker-rail truthfulness,
// 2026-08-17). The Airtable formula below keys on {Rancher Accepted At} = '',
// which is a CONNECT stamp — a represented (broker-rail) ranch has no
// dashboard, no login and no Accept Slot button, so that field is empty for
// every broker sale forever. Silently, every broker sale was therefore taking
// the full Connect treatment: up to 3 emails telling an off-platform rancher to
// "tap Accept Slot in your dashboard", plus the 24h BUYER note whose premise
// ("they haven't confirmed your slot yet… we've already gone back to them") is
// machinery that does not exist on that rail. selectSlaEligible now refuses
// broker rows outright (lib/depositSla::isBrokerRailReferral), which drops BOTH
// the rancher re-ping and the buyer note, since the buyer send lives inside the
// same loop — correct, because on this rail there is no silence to report: with
// no Accept event, "the ranch hasn't confirmed" is not an observation, and
// telling every broker buyer at 24h that their ranch is slow would be a
// manufactured alarm.
//
// What the broker rail KEEPS is the 72h operator escalation (see the escalation
// pass below). That one is Ben-facing, fires once per referral ever, and asks
// the only question this rail can be behind on — did the ranch actually make
// contact? Removing it would have left broker sales with no backstop at all.

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { findPaymentsByReferral } from '@/lib/contracts/payments';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { notifyRancherDepositPaid } from '@/lib/rancherNotify';
import { claimOnce } from '@/lib/rancherCapacity';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { sendBuyerDepositDelayNotice } from '@/lib/emailMinimal';
import {
  selectSlaEligible,
  selectEscalationDue,
  isBrokerRailReferral,
  hoursSinceDeposit,
  DEFAULT_SLA_HOURS,
  ESCALATION_AFTER_HOURS,
} from '@/lib/depositSla';

export const maxDuration = 60;

const MAX_PER_RUN = 25;

// Hours the deposit must sit unaccepted before the BUYER gets their one
// honest delay note. Deliberately later than the rancher SLA (default 4h):
// the rancher gets chased first; the buyer is told once it is genuinely
// "slower than usual" against the "usually the same day" promise.
// Constant on purpose (not an env) — one more undocumented knob is worse
// than a code change if the threshold ever needs to move.
const BUYER_DELAY_HOURS = 24;
// One per referral EVER (bounded by the claim TTL).
const BUYER_DELAY_CLAIM_TTL_SEC = 365 * 24 * 60 * 60;
// Email-hygiene 2026-08-02: past 72h the rancher re-ping rail is DONE (the
// selector's time-derived cap already stopped emailing them at ~3 pings) and
// a human takes over — ONE loud operator escalation per referral, ever.
// Same one-shot pattern as the buyer delay notice: Redis claimOnce keyed on
// the referral (no free Referrals field), claim taken BEFORE the send, with
// sendOperatorSignal's own dedupeKey as the belt.
const ESCALATION_CLAIM_TTL_SEC = 365 * 24 * 60 * 60;
const MAX_ESCALATIONS_PER_RUN = 10;

async function realHandler(
  _request: Request,
): Promise<{ status: 'success' | 'partial' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const now = Date.now();
  const slaHours = Number(process.env.DEPOSIT_ACCEPT_SLA_HOURS) || DEFAULT_SLA_HOURS;

  // Pull deposits that landed but aren't accepted yet. Keying on Deposit Paid At
  // being present catches BOTH the canonical Awaiting Payment state and any
  // referral that drifted to Slot Locked without an accept stamp.
  //
  // NOTE: we deliberately do NOT reference {Refunded At} in this formula —
  // restoreReferralAfterRefund has a schema fallback implying that field may not
  // exist on the Referrals table, and an unknown field name makes Airtable error
  // the whole query. Refund/dispute exclusion is enforced AFTER enrichment via
  // the linked Payments row (authoritative) + the selector's JS-side Referral
  // field reads (safe when the field is absent).
  let candidates: any[] = [];
  try {
    candidates = (await getAllRecords(
      TABLES.REFERRALS,
      `AND({Deposit Paid At} != '', {Rancher Accepted At} = '')`,
    )) as any[];
  } catch (e: any) {
    return {
      status: 'partial',
      recordsTouched: 0,
      notes: `query failed: ${e?.message?.slice(0, 200) || 'unknown'}`,
    };
  }

  // Enrich each candidate with its linked Payments row + Ranchers row BEFORE
  // the eligibility filter.
  //
  // PAYMENTS: a deposit refunded/disputed while still Awaiting Payment is NOT
  // reflected on the Referral (restoreReferralAfterRefund only flips Closed
  // Won; markDepositDisputed writes only the Payments row) — the Payments row
  // is the authoritative signal. Without this the cron re-pings refunded /
  // disputed deposits forever. Best-effort per row: a lookup failure leaves
  // __payment null and the row is still gated by the Referral-side checks.
  //
  // RANCHER: the `Broker Rail` checkbox is the authoritative rail signal, and
  // the selector needs it BEFORE it decides (a broker row must never reach the
  // Connect re-ping). Reading it here rather than inside the ping loop also
  // means no row is fetched twice — the loop below reuses `__rancher`, so the
  // only added Airtable reads are for candidates that turn out to be ineligible.
  // Best-effort: a lookup failure leaves __rancher null, the two marker signals
  // in isBrokerRailReferral still stand, and the ping loop skips the row anyway
  // because it cannot notify a rancher it could not read.
  for (const ref of candidates) {
    try {
      // Same link resolution the ping loop uses. An empty link array yields no
      // id and leaves __rancher null rather than querying for `undefined`.
      const linked: unknown = ref['Rancher'] || ref['Suggested Rancher'];
      const linkedId = Array.isArray(linked) ? linked[0] : null;
      ref.__rancher = linkedId ? await getRecordById(TABLES.RANCHERS, String(linkedId)) : null;
    } catch (e: any) {
      ref.__rancher = null;
      console.warn(`[deposit-accept-sla] rancher lookup failed for ${ref.id} (non-fatal):`, e?.message);
    }
    try {
      // Payments-by-referral (G1/E6): exact match on {Referral Id Text} first,
      // legacy ARRAYJOIN scan only as back-compat fallback (see
      // findPaymentsByReferral in lib/contracts/payments.ts).
      const payments = (await findPaymentsByReferral(String(ref.id))) as any[];
      // Prefer a refunded/disputed row if any exists so a partial-refund or
      // dispute on one of several Payments rows still excludes the referral.
      ref.__payment =
        payments.find(
          (p) =>
            p['Refunded At'] ||
            String(p['Status'] || '').toLowerCase() === 'refunded' ||
            String(p['Dispute Status'] || '').trim(),
        ) || payments[0] || null;
    } catch (e: any) {
      ref.__payment = null;
      console.warn(`[deposit-accept-sla] payments lookup failed for ${ref.id} (non-fatal):`, e?.message);
    }
  }

  const eligible = selectSlaEligible(candidates, { now, slaHours });
  const toPing = eligible.slice(0, MAX_PER_RUN);

  const errors: string[] = [];
  let pinged = 0;
  let buyersTold = 0;

  for (const ref of toPing) {
    const refId = ref.id;
    const buyerName = ref['Buyer Name'] || '?';
    const rancherIds: string[] = ref['Rancher'] || ref['Suggested Rancher'] || [];
    const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
    if (!rancherId) {
      errors.push(`${refId}: no rancher linked`);
      continue;
    }

    // Already read during enrichment (which is where the rail decision needed
    // it) — never re-fetched here.
    const rancher: any = ref.__rancher;
    if (!rancher) {
      errors.push(`${refId}: rancher record missing or unreadable`);
      continue;
    }

    const hrs = hoursSinceDeposit(ref, now);

    // Stamp the dedupe BEFORE the side effects. If the stamp write fails we
    // abort this referral so a failed write can't lead to a re-ping storm on
    // the next hourly run (same ordering fix as awaiting-payment-nudge).
    try {
      await updateRecord(TABLES.REFERRALS, refId, {
        'Rancher Re-pinged At': new Date().toISOString(),
      });
    } catch (e: any) {
      errors.push(`${refId}: dedupe stamp failed (${e?.message?.slice(0, 80)})`);
      continue;
    }

    // Re-ping the rancher (email + SMS), then escalate to Ben. Both are
    // best-effort; notifyRancherDepositPaid never throws.
    try {
      await notifyRancherDepositPaid(ref, rancher, { isReminder: true });
    } catch (e: any) {
      errors.push(`${refId}: rancher re-notify failed (${e?.message?.slice(0, 80)})`);
      // fall through — still escalate to Ben below.
    }

    const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || '?';
    try {
      if (TELEGRAM_ADMIN_CHAT_ID) {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `⏰ <b>UNACCEPTED PAID DEPOSIT — ${hrs}h</b>\n\n` +
            `${buyerName} paid, ${rancherName} hasn't tapped Accept Slot.\n` +
            `Re-pinged the rancher by email${process.env.ENABLE_SMS === 'true' ? ' + text' : ''}. Buyer is waiting on a call.\n\n` +
            `Nudge them: <code>${process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com'}/rancher</code>\n` +
            `ref=${String(refId).slice(-6)}`,
        );
      }
      pinged++;
    } catch (e: any) {
      errors.push(`${refId}: telegram failed (${e?.message?.slice(0, 80)})`);
    }

    // ── TELL THE BUYER (Wave 2) — one honest note per referral, ever ───────
    // Fully isolated: a failure here can never break the rancher re-ping or
    // the operator escalation above. Claim-before-send: the Redis claim is
    // the one-shot throttle (no free Referrals field exists for a stamp), so
    // it is taken BEFORE the send — a crashed run costs one note, never two.
    if (hrs >= BUYER_DELAY_HOURS) {
      const buyerEmail = String(ref['Buyer Email'] || '').trim();
      if (buyerEmail) {
        try {
          const wonNotice = await claimOnce(
            `deposit-buyer-delay:${refId}`,
            BUYER_DELAY_CLAIM_TTL_SEC,
          );
          if (wonNotice) {
            const rName =
              rancher['Ranch Name'] || rancher['Operator Name'] || 'your rancher';
            await sendBuyerDepositDelayNotice({
              buyerEmail,
              buyerName: String(ref['Buyer Name'] || ''),
              rancherName: String(rName),
              cutLabel: String(ref['Order Type'] || ''),
              hoursSinceDeposit: hrs,
            });
            buyersTold++;
          }
        } catch (e: any) {
          errors.push(`${refId}: buyer delay notice failed (${e?.message?.slice(0, 80)})`);
        }
      }
    }
  }

  // ── 72h+: ONE loud operator escalation per referral (email-hygiene) ────────
  // The rancher heard from us ~3 times and never tapped Accept — more email is
  // noise. Hand the deal to a human, loudly, exactly once. claimOnce fires
  // BEFORE the send so a crashed run costs one escalation, never a repeat;
  // sendOperatorSignal's dedupeKey backstops the local-dev no-Redis case.
  let escalationsSent = 0;
  const escalationDue = selectEscalationDue(candidates, { now });
  for (const ref of escalationDue.slice(0, MAX_ESCALATIONS_PER_RUN)) {
    const refId = ref.id;
    try {
      const won = await claimOnce(`deposit-sla-escalation:${refId}`, ESCALATION_CLAIM_TTL_SEC);
      if (!won) continue;
      const hrs = hoursSinceDeposit(ref, now);
      // Rancher name for the card, from the enrichment read above. Null (an
      // unreadable record) never blocks the escalation itself.
      const escRancher: any = ref.__rancher;
      const rancherLabel =
        escRancher?.['Operator Name'] || escRancher?.['Ranch Name'] || 'the rancher';
      const buyerLabel = String(ref['Buyer Name'] || 'A buyer');
      // BROKER RAIL — the same 72h trigger, a different question. This rail has
      // no Accept Slot, no thread and no payout event, so "unaccepted" is not a
      // finding here and the machine never emailed this rancher at all. What
      // Ben actually needs to know is whether the ranch picked up the order and
      // called the buyer — the one thing nothing in the system can observe.
      const broker = isBrokerRailReferral(ref);
      await sendOperatorSignal({
        urgency: 'loud',
        kind: 'stuck-rancher',
        summary: broker
          ? `broker sale ${hrs}h old — confirm the ranch made contact`
          : `paid deposit unaccepted ${hrs}h — manual intervention needed`,
        detail: broker
          ? `${buyerLabel} paid a deposit ${hrs}h ago on the represented-seller rail with ${rancherLabel}. ` +
            `Nothing in the system can tell us whether that ranch has the order or has called the buyer — ` +
            `this rail has no dashboard and no accept step. Check the ranch has the fulfillment sheet, ` +
            `then call them. This alert fires once.`
          : `${buyerLabel} paid a deposit ${hrs}h ago and ${rancherLabel} ` +
            `still hasn't tapped Accept Slot. The rancher has had 3 email pings — automated chasing is DONE ` +
            `for this deal. Call ${rancherLabel}, re-route the buyer, or refund. This alert fires once.`,
        refs: [{ type: 'referral', id: String(refId) }],
        dedupeKey: `deposit-sla-escalation:${refId}`,
        dedupeWindowMs: 7 * 24 * 60 * 60 * 1000,
      });
      escalationsSent++;
    } catch (e: any) {
      errors.push(`${refId}: escalation failed (${e?.message?.slice(0, 80)})`);
    }
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: pinged + buyersTold + escalationsSent,
    notes: `candidates=${candidates.length} eligible=${eligible.length} pinged=${pinged} buyersTold=${buyersTold} escalated=${escalationsSent}/${escalationDue.length} slaHrs=${slaHours} buyerDelayHrs=${BUYER_DELAY_HOURS} escHrs=${ESCALATION_AFTER_HOURS} errs=${errors.length}${errors.length ? ' err1=' + errors[0].slice(0, 80) : ''}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('deposit-accept-sla', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
