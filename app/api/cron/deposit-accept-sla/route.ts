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
// re-pings each stuck deposit at most ~once/day.
//
// Mirrors awaiting-payment-nudge: CRON_SECRET auth wrapper + withCronRun +
// maintenance gate + throttle-stamp-BEFORE-side-effect ordering.

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { CRON_SECRET } from '@/lib/secrets';
import { withCronRun } from '@/lib/cronRun';
import { notifyRancherDepositPaid } from '@/lib/rancherNotify';
import { selectSlaEligible, hoursSinceDeposit, DEFAULT_SLA_HOURS } from '@/lib/depositSla';

export const maxDuration = 60;

const MAX_PER_RUN = 25;

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

  // Enrich each candidate with its linked Payments row BEFORE the eligibility
  // filter. A deposit refunded/disputed while still Awaiting Payment is NOT
  // reflected on the Referral (restoreReferralAfterRefund only flips Closed
  // Won; markDepositDisputed writes only the Payments row) — the Payments row
  // is the authoritative signal. Without this the cron re-pings refunded /
  // disputed deposits forever. Best-effort per row: a lookup failure leaves
  // __payment null and the row is still gated by the Referral-side checks.
  for (const ref of candidates) {
    try {
      const safeId = String(ref.id).replace(/"/g, '\\"');
      const payments = (await getAllRecords(
        TABLES.PAYMENTS,
        `SEARCH("${safeId}", ARRAYJOIN({Referral}))`,
      )) as any[];
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

  for (const ref of toPing) {
    const refId = ref.id;
    const buyerName = ref['Buyer Name'] || '?';
    const rancherIds: string[] = ref['Rancher'] || ref['Suggested Rancher'] || [];
    const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
    if (!rancherId) {
      errors.push(`${refId}: no rancher linked`);
      continue;
    }

    let rancher: any = null;
    try {
      rancher = await getRecordById(TABLES.RANCHERS, rancherId);
    } catch (e: any) {
      errors.push(`${refId}: rancher fetch failed (${e?.message})`);
      continue;
    }
    if (!rancher) {
      errors.push(`${refId}: rancher record missing`);
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
            `Re-pinged the rancher (email + text). Buyer is waiting on a call.\n\n` +
            `Nudge them: <code>${process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com'}/rancher</code>\n` +
            `ref=${String(refId).slice(-6)}`,
        );
      }
      pinged++;
    } catch (e: any) {
      errors.push(`${refId}: telegram failed (${e?.message?.slice(0, 80)})`);
    }
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: pinged,
    notes: `candidates=${candidates.length} eligible=${eligible.length} pinged=${pinged} slaHrs=${slaHours} errs=${errors.length}${errors.length ? ' err1=' + errors[0].slice(0, 80) : ''}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  if (CRON_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      const { searchParams } = new URL(request.url);
      if (searchParams.get('secret') !== CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('deposit-accept-sla', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
