// app/api/cron/deposit-request-nudge/route.ts
//
// LEAK 2 of the rancher-driven deposit rail (2026-07-05): BUYER-facing
// follow-up on an unpaid deposit request. Before this cron, a buyer who got a
// rancher-sent deposit link and didn't pay heard NOTHING for 14 days — and
// that 14-day net (awaiting-payment-nudge) pings the RANCHER. Rancher-sent
// requests were 0-for-7 paid.
//
// Hourly. Selection is pure + unit-tested (lib/depositRequestNudge):
// Deposit Requested At set · Deposit Paid At empty · Status='Awaiting
// Payment' · request >= 24h old · < 2 lifetime nudges · outside 48h cooldown.
// Suppression trio enforced on the linked Consumer here; guardedSend's global
// suppression list backs it up.
//
// CLAIM-BEFORE-SEND: the dedupe stamp ('Deposit Nudge Last Sent At' +
// 'Deposit Nudge Count') is written BEFORE the send, then verified — if the
// stamp didn't persist (fields missing → updateRecord silently strips), the
// run ABORTS before any further send: no dedupe = no sends (the
// waiting-activation pattern).
//
// LINK: the magic-link → deposit-page hop, NOT the stored Stripe session URL
// ('Deposit Checkout URL') — Stripe Checkout sessions expire in ~24h, which
// is exactly when this cron first fires. The deposit page mints a fresh
// session on arrival.

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES, isInvalidFilterFormulaError } from '@/lib/airtable';
import { findPaymentsByReferral } from '@/lib/contracts/payments';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendDepositRequestNudge } from '@/lib/emailMinimal';
import { sendDemandRouterCampaign } from '@/lib/email';
import { sendSMSToConsumer } from '@/lib/twilio';
import { smsEnabled } from '@/lib/smsFlag';
import { isSmsWindow } from '@/lib/sendWindow';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { generateMemberLoginToken } from '@/lib/secrets';
import { selectDepositNudges, selectDepositAbandonNudges } from '@/lib/depositRequestNudge';
import { isRancherOperationalForBuyers, isRancherOnConnect } from '@/lib/rancherEligibility';
import {
  selectReserveAbandonRecovery,
  isRecoveryEmailEligible,
  renderRecoveryEmail,
  renderRecoverySms,
  DEFAULT_RESERVE_RECOVERY_HOURS,
  DEFAULT_RESERVE_RECOVERY_SMS_HOURS,
  DEFAULT_RESERVE_RECOVERY_MAX_AGE_DAYS,
  RECOVERY_CAMPAIGN_NAME,
  RECOVERY_EMAIL_TEMPLATE,
  RESERVE_RECOVERY_EMAIL_FIELD,
  RESERVE_RECOVERY_SMS_FIELD,
} from '@/lib/reserveRecovery';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

interface CronResult {
  status: 'success' | 'partial' | 'error' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
}

// Candidate formula — long-standing fields only in the required clauses; the
// nudge-stamp fields exist (created 2026-07-05) but the selector re-checks
// everything JS-side, so the formula is purely an I/O optimization.
const CANDIDATE_FORMULA =
  `AND({Status}="Awaiting Payment", NOT({Deposit Requested At}=""), {Deposit Paid At}="")`;

// DEPOSIT-ABANDON RAIL (2026-07-05): quiz-complete deposit invites (Deposit
// Invite Sent At set) that were never paid and aren't past the deposit ask.
// Disjoint from the rancher-request rail via the empty Deposit Requested At
// clause; the JS selector re-checks age/cap/cooldown/terminal-status.
const ABANDON_CANDIDATE_FORMULA =
  `AND(NOT({Deposit Invite Sent At}=""), {Deposit Requested At}="", {Deposit Paid At}="")`;

// RAIL C — RESERVE-ABANDON (2026-07-22, reactivation audit): a self-serve
// reserve referral (Match Type contains 'Deposit' — minted by /api/checkout/
// reserve or a /r/d 1-tap link) carries NEITHER 'Deposit Requested At' NOR
// 'Deposit Invite Sent At', so rails A+B can't see it — and the demand-router
// recovery is deliberately campaign-scoped (Foodstead+Silverline only). This
// rail chases the same abandoned-reserve cohort for ALL operational Connect
// ranchers, reusing lib/reserveRecovery's pure selectors + stamps (the two
// crons share the stamp fields, so whoever fires first wins — idempotent).
// Disjoint from rails A+B via the two empty-stamp clauses.
const RESERVE_ABANDON_FORMULA =
  `AND({Deposit Paid At}="", {Deposit Requested At}="", {Deposit Invite Sent At}="", FIND("Deposit", {Match Type}&""))`;

interface ReserveRailResult {
  selectedEmail: number;
  selectedSms: number;
  emailSent: number;
  smsSent: number;
  suppressed: number;
  errors: string[];
  /** Non-empty when the run aborted (stamp fields missing in Airtable). */
  aborted: string;
}

async function runReserveAbandonRail(nowMs: number): Promise<ReserveRailResult> {
  const out: ReserveRailResult = {
    selectedEmail: 0, selectedSms: 0, emailSent: 0, smsSent: 0, suppressed: 0, errors: [], aborted: '',
  };
  // Kill-switch (defaults ON — this is the launch cohort's only chase).
  if (process.env.RESERVE_ABANDON_RECOVERY_ENABLED === 'false') return out;

  let rows: any[] = [];
  try {
    rows = (await getAllRecords(TABLES.REFERRALS, RESERVE_ABANDON_FORMULA)) as any[];
  } catch (e: any) {
    if (isInvalidFilterFormulaError(e)) {
      console.warn('[deposit-request-nudge] reserve-abandon formula rejected; falling back to full scan');
      rows = (await getAllRecords(TABLES.REFERRALS).catch(() => [])) as any[];
    } else {
      console.warn('[deposit-request-nudge] reserve-abandon read failed (non-fatal):', e?.message);
      return out;
    }
  }

  const selectOpts = {
    now: nowMs,
    recoveryHours: Number(process.env.RESERVE_RECOVERY_HOURS || DEFAULT_RESERVE_RECOVERY_HOURS),
    smsHours: Number(process.env.RESERVE_RECOVERY_SMS_HOURS || DEFAULT_RESERVE_RECOVERY_SMS_HOURS),
    maxAgeDays: Number(process.env.RESERVE_RECOVERY_MAX_AGE_DAYS || DEFAULT_RESERVE_RECOVERY_MAX_AGE_DAYS),
    batchCap: 25,
  };
  const picked = selectReserveAbandonRecovery(rows, selectOpts);
  out.selectedEmail = picked.email.length;
  out.selectedSms = picked.sms.length;
  const smsOn = smsEnabled();

  // Shared per-referral context: linked rancher must be operational AND on
  // Connect (the deposit page hard-409s off-Connect — never email a dead-end
  // link), linked Consumer carries the suppression trio + email/phone/state.
  const resolveContext = async (r: any): Promise<
    | { buyer: any; buyerId: string; buyerEmail: string; rancherName: string; cut: string; link: string }
    | 'suppressed'
    | null
  > => {
    const rancherId: string = ((r['Rancher'] || r['Suggested Rancher'] || []) as string[])[0] || '';
    if (!rancherId) return null;
    const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
    if (!rancher || !isRancherOperationalForBuyers(rancher) || !isRancherOnConnect(rancher)) return null;
    const buyerId: string = ((r['Buyer'] || []) as string[])[0] || '';
    if (!buyerId) return null;
    const buyer: any = await getRecordById(TABLES.CONSUMERS, buyerId).catch(() => null);
    if (!buyer) return null;
    if (buyer['Unsubscribed'] || buyer['Bounced'] || buyer['Complained']) return 'suppressed';
    const buyerEmail = String(buyer['Email'] || r['Buyer Email'] || '').trim().toLowerCase();
    if (!buyerEmail) return null;
    const rancherName = String(rancher['Operator Name'] || rancher['Ranch Name'] || 'your rancher').trim();
    const cutRaw = String(r['Order Type'] || buyer['Order Type'] || '').trim().toLowerCase().split(/\s+/)[0];
    const cut = cutRaw === 'quarter' || cutRaw === 'half' || cutRaw === 'whole' ? cutRaw : 'beef';
    // Magic-link hop → deposit page (fresh Stripe session minted on arrival —
    // NEVER the stored ~24h-expiry Checkout URL). Same link rails A+B use.
    const token = generateMemberLoginToken(buyerId, buyerEmail);
    const link = `${SITE_URL}/api/auth/member/verify?token=${token}&next=${encodeURIComponent(`/checkout/${r.id}/deposit`)}`;
    return { buyer, buyerId, buyerEmail, rancherName, cut, link };
  };

  // ── Step 1: recovery EMAIL ──
  for (const r of picked.email) {
    try {
      // Refund/dispute truth: linked Payments row (authoritative) — attached
      // only for the capped survivors (no N+1 over the whole table), then the
      // pure predicate re-judges the row.
      try {
        const payments = (await findPaymentsByReferral(String(r.id))) as any[];
        r.__payment =
          payments.find(
            (p) =>
              p['Refunded At'] ||
              String(p['Status'] || '').toLowerCase() === 'refunded' ||
              String(p['Dispute Status'] || '').trim(),
          ) || payments[0] || null;
      } catch { r.__payment = null; }
      if (!isRecoveryEmailEligible(r, selectOpts)) continue;

      const ctx = await resolveContext(r);
      if (ctx === 'suppressed') { out.suppressed++; continue; }
      if (!ctx) continue;

      // CLAIM BEFORE SEND + verify-persist: the stamp fields are NEW on
      // Referrals (updateRecord silently strips unknown fields) — no dedupe
      // stamp means an hourly re-send storm, so ABORT the rail entirely.
      const updated: any = await updateRecord(TABLES.REFERRALS, r.id, {
        [RESERVE_RECOVERY_EMAIL_FIELD]: new Date(nowMs).toISOString(),
      });
      if (!updated || !updated[RESERVE_RECOVERY_EMAIL_FIELD]) {
        out.aborted =
          `reserve-abandon stamp did not persist for ${r.id} — create "${RESERVE_RECOVERY_EMAIL_FIELD}" ` +
          `(dateTime) + "${RESERVE_RECOVERY_SMS_FIELD}" (dateTime) on Referrals`;
        return out;
      }

      const msg = renderRecoveryEmail({
        firstName: String(ctx.buyer['Full Name'] || r['Buyer Name'] || '').trim().split(/\s+/)[0] || 'there',
        cut: ctx.cut,
        rancher: ctx.rancherName,
        link: ctx.link,
      });
      const res = await sendDemandRouterCampaign({
        email: ctx.buyerEmail,
        subject: msg.subject,
        html: msg.html,
        templateName: RECOVERY_EMAIL_TEMPLATE,
        recipientConsumerId: ctx.buyerId,
        replyConsumerId: ctx.buyerId,
        campaign: RECOVERY_CAMPAIGN_NAME,
      });
      if ((res as any)?.suppressed) out.suppressed++;
      else if ((res as any)?.success) out.emailSent++;
      await new Promise((res2) => setTimeout(res2, 400)); // pace Resend + Airtable
    } catch (e: any) {
      out.errors.push(`reserve-email ${r.id}: ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
  }

  // ── Step 2: recovery SMS (opt-in + quiet-hours gated; email step already
  // fired > smsHours ago per the pure selector) ──
  for (const r of picked.sms) {
    try {
      const ctx = await resolveContext(r);
      if (ctx === 'suppressed') { out.suppressed++; continue; }
      if (!ctx) continue;
      // ENABLE_SMS / opt-in / TCPA-window checks BEFORE any stamp — a skip
      // here must not burn the one-shot SMS stamp.
      if (!smsOn || !ctx.buyer['SMS Opt-In']) continue;
      if (!isSmsWindow(ctx.buyer['State'], nowMs)) continue;

      const updated: any = await updateRecord(TABLES.REFERRALS, r.id, {
        [RESERVE_RECOVERY_SMS_FIELD]: new Date(nowMs).toISOString(),
      });
      if (!updated || !updated[RESERVE_RECOVERY_SMS_FIELD]) {
        out.aborted =
          `reserve-abandon SMS stamp did not persist for ${r.id} — create "${RESERVE_RECOVERY_SMS_FIELD}" ` +
          `(dateTime) on Referrals`;
        return out;
      }
      const body = renderRecoverySms({
        firstName: String(ctx.buyer['Full Name'] || r['Buyer Name'] || '').trim().split(/\s+/)[0] || 'there',
        cut: ctx.cut,
        rancher: ctx.rancherName,
        link: ctx.link,
      });
      const ok = await sendSMSToConsumer({ consumer: ctx.buyer, body, reason: 'deposit-request-nudge reserve-recovery' });
      if (ok) out.smsSent++;
      await new Promise((res2) => setTimeout(res2, 400));
    } catch (e: any) {
      out.errors.push(`reserve-sms ${r.id}: ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
  }

  return out;
}

async function realHandler(_request: Request): Promise<CronResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const nowMs = Date.now();

  let candidates: any[] = [];
  try {
    candidates = (await getAllRecords(TABLES.REFERRALS, CANDIDATE_FORMULA)) as any[];
  } catch (e: any) {
    if (isInvalidFilterFormulaError(e)) {
      // Field renamed → degrade to the unfiltered scan (self-heal pattern).
      console.warn('[deposit-request-nudge] formula rejected; falling back to full scan');
      candidates = (await getAllRecords(TABLES.REFERRALS)) as any[];
    } else {
      return { status: 'error', recordsTouched: 0, notes: `referrals read failed: ${e?.message?.slice(0, 160)}` };
    }
  }

  // Rail B — deposit-abandon (quiz-complete invites unpaid). Best-effort: a
  // read failure here must NOT sink the rancher-request rail above.
  let abandonCandidates: any[] = [];
  try {
    abandonCandidates = (await getAllRecords(TABLES.REFERRALS, ABANDON_CANDIDATE_FORMULA)) as any[];
  } catch (e: any) {
    if (isInvalidFilterFormulaError(e)) {
      console.warn('[deposit-request-nudge] abandon formula rejected; falling back to full scan');
      abandonCandidates = (await getAllRecords(TABLES.REFERRALS)) as any[];
    } else {
      console.warn('[deposit-request-nudge] abandon read failed (non-fatal):', e?.message);
      abandonCandidates = [];
    }
  }

  // Merge both rails, dedupe by id (the two selectors are disjoint by design,
  // but dedupe is cheap insurance), total capped so one run never floods.
  const railA = selectDepositNudges(candidates, { nowMs, batchCap: 25 });
  const railB = selectDepositAbandonNudges(abandonCandidates, { nowMs, batchCap: 25 });
  const seen = new Set<string>();
  const selected = [...railA, ...railB].filter((r) => {
    const id = String(r.id || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, 25);

  let sent = 0;
  let suppressed = 0;
  const errors: string[] = [];

  for (const r of selected) {
    try {
      // Linked Consumer — suppression trio + email + phone live there.
      const buyerId: string = ((r['Buyer'] || []) as string[])[0] || '';
      if (!buyerId) continue;
      const buyer: any = await getRecordById(TABLES.CONSUMERS, buyerId);
      if (!buyer) continue;
      if (buyer['Unsubscribed'] || buyer['Bounced'] || buyer['Complained']) { suppressed++; continue; }
      const buyerEmail = String(buyer['Email'] || '').trim().toLowerCase();
      if (!buyerEmail) continue;

      const priorCount = Number(r['Deposit Nudge Count']) || 0;
      const touch: 1 | 2 = priorCount >= 1 ? 2 : 1;

      // CLAIM BEFORE SEND + verify-persist (fields-missing abort).
      const updated: any = await updateRecord(TABLES.REFERRALS, r.id, {
        'Deposit Nudge Last Sent At': new Date().toISOString(),
        'Deposit Nudge Count': priorCount + 1,
      });
      if (!updated || !updated['Deposit Nudge Last Sent At']) {
        return {
          status: 'error',
          recordsTouched: sent,
          notes:
            `ABORT: nudge stamp did not persist for ${r.id} — verify "Deposit Nudge Last Sent At" ` +
            `(dateTime) + "Deposit Nudge Count" (number) exist on Referrals. sentBeforeAbort=${sent}`,
        };
      }

      // Rancher context for the copy (name + phone). Best-effort.
      let rancherName = String(r['Suggested Rancher Name'] || '').trim();
      let rancherPhone = '';
      try {
        const rancherId: string = ((r['Rancher'] || []) as string[])[0] || '';
        if (rancherId) {
          const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
          rancherName = String(rancher?.['Ranch Name'] || rancherName || 'your rancher').trim();
          rancherPhone = String(rancher?.['Phone'] || '').trim();
        }
      } catch { /* copy falls back to generic */ }

      const cutTier = String(r['Order Type'] || 'share').replace(/\s*cow\s*$/i, '').trim() || 'share';
      const buyerFirst = String(buyer['Full Name'] || r['Buyer Name'] || 'there').split(/\s+/)[0];

      // Magic-link hop → deposit page (fresh Stripe session minted there).
      const token = generateMemberLoginToken(buyerId, buyerEmail);
      const checkoutUrl = `${SITE_URL}/api/auth/member/verify?token=${token}&next=${encodeURIComponent(`/checkout/${r.id}/deposit`)}`;

      const res = await sendDepositRequestNudge({
        buyerEmail,
        buyerName: buyerFirst,
        rancherName: rancherName || 'your rancher',
        cutTier,
        checkoutUrl,
        rancherPhone: rancherPhone || undefined,
        touch,
      });
      if ((res as any)?.success === false) suppressed++;
      else sent++;

      await new Promise((res2) => setTimeout(res2, 400)); // pace Resend + Airtable
    } catch (e: any) {
      errors.push(`${r.id}: ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
  }

  // Rail C — reserve-abandon recovery (all operational Connect ranchers).
  const reserve = await runReserveAbandonRail(nowMs);
  errors.push(...reserve.errors);
  if (reserve.aborted) {
    // Missing stamp fields: surface loudly (no dedupe = the rail stays dark).
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'system-error',
      summary: 'reserve-abandon rail ABORTED — stamp fields missing on Referrals',
      detail: reserve.aborted,
      dedupeKey: 'deposit-request-nudge-reserve-abort',
      dedupeWindowMs: 24 * 60 * 60 * 1000,
    }).catch(() => {});
  }
  const reserveNote =
    ` reserve: sel=${reserve.selectedEmail}+${reserve.selectedSms} email=${reserve.emailSent} sms=${reserve.smsSent}` +
    (reserve.aborted ? ' ABORTED(fields-missing)' : '');

  if (selected.length > 0 || reserve.emailSent > 0 || reserve.smsSent > 0) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'other',
      summary: `deposit-request-nudge: ${sent + reserve.emailSent + reserve.smsSent} buyer nudge${sent + reserve.emailSent + reserve.smsSent === 1 ? '' : 's'} sent`,
      detail: `request=${candidates.length} abandon=${abandonCandidates.length} selected=${selected.length} sent=${sent} suppressed=${suppressed + reserve.suppressed} errs=${errors.length}${reserveNote}`,
      dedupeKey: 'deposit-request-nudge-summary',
      dedupeWindowMs: 6 * 60 * 60 * 1000,
    }).catch(() => {});
  }

  return {
    status: errors.length || reserve.aborted ? 'partial' : 'success',
    recordsTouched: sent + reserve.emailSent + reserve.smsSent,
    notes:
      `candidates=${candidates.length} selected=${selected.length} sent=${sent} ` +
      `suppressed=${suppressed + reserve.suppressed} errs=${errors.length}` +
      reserveNote +
      (errors.length ? ` err1=${errors[0].slice(0, 80)}` : ''),
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('deposit-request-nudge', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
