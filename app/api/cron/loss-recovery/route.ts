// app/api/cron/loss-recovery/route.ts
//
// LOSS-RECOVERY RAILS — daily 15:25 UTC. When a rancher marks a referral
// Closed Lost with a structured 'Loss Reason', most of those losses are
// recoverable revenue (quarters run $1,500–2,000; halves $3,000–3,700) and
// today NOBODY follows up. This cron closes the loop (lib/lossRecovery.ts
// owns who/what; lib/email.ts owns the words):
//
//   "Couldn't reach buyer"  → re-engage email (+ SMS if TCPA-opted-in and
//                             inside the local SMS window)
//   'Price too high'        → downsell email (quarter / shop boxes)
//   'Timing — buying later' → NO email now; single scheduled-style stamp
//                             ('Warmup Sent At' = now, 'Warmup Stage' =
//                             'nudged') so the EXISTING re-warm-cohort cron
//                             wakes them ~60d out. No new scheduler.
//   everything else         → terminal; counted in the run log only.
//
// ── DRY-RUN BY DEFAULT (the WAITING_ACTIVATION precedent) ────────────────────
// Env LOSS_RECOVERY_ENABLED: anything but 'true' → the exact live selection
// runs read-only and the would-send list comes back in the response notes;
// NO sends, NO 'Recovery Sent At' stamps, NO Notes writes. 'true' → live.
// Optional knob: LOSS_RECOVERY_MAX_PER_RUN (default 20).
//
// SEQUENCING: nothing writes 'Loss Reason' until PR #396's rancher UI lands —
// until then every run selects 0 and no-ops. Safe to ship dark ahead of it.
//
// SAFETY STACK (each layer independent):
//   - pure selector gates: Closed Lost + known reason + once-only via
//     'Recovery Sent At' + 14d close window + suppression + no other active
//     referral + one touch per buyer per run + cap.
//   - 14d window rides the Airtable read (IS_AFTER(LAST_MODIFIED_TIME(), …))
//     because 'Closed At' is often unstamped and Referrals has no
//     last-modified FIELD; if the formula is rejected the selector goes
//     conservative (parseable in-window 'Closed At' required).
//   - claim-before-send: 'Recovery Sent At' stamped + read-back verified
//     BEFORE any send; if the stamp doesn't persist the run ABORTS (a crash
//     burns one touch; a double-send is worse — the product-recovery lesson).
//   - guardedSend underneath: suppression list + 3/7d frequency cap + Email
//     Sends truth. SMS only via sendSMSToConsumer (TCPA gate) + isSmsWindow.
//   - 500ms pacing (Airtable 5 req/s) + soft deadline that exits honestly.

import { getAllRecords, updateRecord, isInvalidFilterFormulaError, TABLES } from '@/lib/airtable';
import { activeDealReferralsFormula } from '@/lib/cronReadFilters';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { sendSMSToConsumer } from '@/lib/twilio';
import { isSmsWindow } from '@/lib/sendWindow';
import { sendLossRecoveryReengage, sendLossRecoveryDownsell } from '@/lib/email';
import {
  selectLossRecovery,
  recoveryNoteLine,
  renderReengageSms,
  RECOVERY_SENT_AT_FIELD,
  LOSS_REASON_FIELD,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_MAX_PER_RUN,
  type LossRecoveryCandidate,
} from '@/lib/lossRecovery';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
const PACING_MS = 500;
const SOFT_DEADLINE_MS = 100_000;

interface CronResult {
  status: 'success' | 'partial' | 'error' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}

function fmtCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (!entries.length) return 'none';
  return entries.map(([k, v]) => `${k}: ${v}`).join(' · ');
}

async function realHandler(_request: Request): Promise<CronResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const live = process.env.LOSS_RECOVERY_ENABLED === 'true';
  const cap = Number(process.env.LOSS_RECOVERY_MAX_PER_RUN) || DEFAULT_MAX_PER_RUN;
  const runStartMs = Date.now();

  // Filtered candidate read. The freshness bound lives HERE because 'Closed
  // At' is often unstamped and there's no last-modified field to read —
  // LAST_MODIFIED_TIME() is only available inside a formula. Setting 'Loss
  // Reason' itself modifies the record, so a fresh rancher close is always
  // inside this bound. On a formula rejection, fall back to the plain
  // Closed Lost scan and let the selector demand a parseable in-window
  // 'Closed At' instead (conservative, never spammy).
  let windowEnforcedUpstream = true;
  let candidates: any[];
  const windowedFormula =
    `AND({Status} = "Closed Lost", {${LOSS_REASON_FIELD}} != BLANK(), ` +
    `{${RECOVERY_SENT_AT_FIELD}} = BLANK(), ` +
    `IS_AFTER(LAST_MODIFIED_TIME(), DATEADD(NOW(), -${DEFAULT_WINDOW_DAYS}, 'days')))`;
  try {
    candidates = (await getAllRecords(TABLES.REFERRALS, windowedFormula)) as any[];
  } catch (e: any) {
    if (!isInvalidFilterFormulaError(e)) throw e;
    console.warn('[loss-recovery] windowed filter rejected; falling back to Closed Lost scan:', e?.message);
    windowEnforcedUpstream = false;
    candidates = (await getAllRecords(TABLES.REFERRALS, `{Status} = "Closed Lost"`)) as any[];
  }

  // Pre-#396 (and most days after): nothing carries a Loss Reason yet → done.
  if (candidates.length === 0) {
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `no closed-lost referrals with ${LOSS_REASON_FIELD} awaiting recovery`,
      skipReasonBreakdown: { 'no-candidates': 1 },
    };
  }

  const [activeReferrals, consumers] = await Promise.all([
    getAllRecords(TABLES.REFERRALS, activeDealReferralsFormula()) as Promise<any[]>,
    getAllRecords(TABLES.CONSUMERS) as Promise<any[]>,
  ]);
  const consumersById = new Map<string, Record<string, any>>();
  for (const c of consumers) consumersById.set(c.id, c);

  const sel = selectLossRecovery({
    candidates,
    activeReferrals,
    consumersById,
    nowMs: runStartMs,
    windowDays: DEFAULT_WINDOW_DAYS,
    cap,
    windowEnforcedUpstream,
  });
  const byAction = { reengage: 0, downsell: 0, nurture: 0 } as Record<string, number>;
  for (const p of sel.planned) byAction[p.action]++;

  // ── DRY RUN (default): no sends, no stamps — would-send list in the notes ──
  if (!live) {
    const wouldSend = sel.planned.map((p) => `${p.referralId}:${p.action}`).join(', ');
    if (sel.planned.length > 0) {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🪃 <b>loss recovery DRY RUN</b> — nothing sent\n\n` +
          `would touch <b>${sel.planned.length}</b> (re-engage ${byAction.reengage} · downsell ${byAction.downsell} · nurture-stamp ${byAction.nurture}${sel.capped ? ` · ${sel.capped} over cap` : ''})\n` +
          `reasons seen: ${fmtCounts(sel.reasonCounts)}\n\n` +
          `flip LOSS_RECOVERY_ENABLED=true in Vercel to go live.`,
      ).catch(() => {});
    }
    return {
      status: 'success',
      recordsTouched: 0,
      notes:
        `DRY RUN (LOSS_RECOVERY_ENABLED!=true) pool=${candidates.length} would=${sel.planned.length} ` +
        `(reengage=${byAction.reengage} downsell=${byAction.downsell} nurture=${byAction.nurture}) cap=${cap} capped=${sel.capped} ` +
        `reasons={${fmtCounts(sel.reasonCounts)}} wouldSend=[${wouldSend}] — no sends, no stamps`,
      skipReasonBreakdown: { ...sel.skips, ...(sel.planned.length ? { 'dry-run-would-send': sel.planned.length } : {}) },
    };
  }

  // ── LIVE ─────────────────────────────────────────────────────────────────
  const done = { reengage: 0, downsell: 0, nurture: 0 } as Record<string, number>;
  let smsSent = 0;
  let suppressed = 0;
  let timeBoxed = false;
  const errors: string[] = [];

  for (const cand of sel.planned as LossRecoveryCandidate[]) {
    if (Date.now() - runStartMs > SOFT_DEADLINE_MS) { timeBoxed = true; break; }
    try {
      // CLAIM BEFORE SEND + read-back verify. One recovery per referral, ever.
      // If the stamp doesn't persist, ABORT before any further send.
      const noteLine = recoveryNoteLine(cand.action, cand.reason, Date.now());
      const updated: any = await updateRecord(TABLES.REFERRALS, cand.referralId, {
        [RECOVERY_SENT_AT_FIELD]: new Date().toISOString(),
        Notes: (cand.existingNotes ? `${cand.existingNotes}\n` : '') + noteLine,
      });
      if (!updated || !updated[RECOVERY_SENT_AT_FIELD]) {
        return {
          status: 'error',
          recordsTouched: done.reengage + done.downsell + done.nurture,
          notes: `ABORT: '${RECOVERY_SENT_AT_FIELD}' did not persist for ${cand.referralId} — verify the field on Referrals. doneBeforeAbort=${JSON.stringify(done)}`,
          skipReasonBreakdown: sel.skips,
        };
      }

      if (cand.action === 'reengage') {
        const res = await sendLossRecoveryReengage({ firstName: cand.firstName, email: cand.email, cut: cand.cut });
        if (res.success) done.reengage++;
        else suppressed++;
        // SMS leg: TCPA opt-in (re-checked by sendSMSToConsumer) + local window.
        if (res.success && cand.smsEligible && isSmsWindow(cand.state, Date.now())) {
          const ok = await sendSMSToConsumer({
            consumer: consumersById.get(cand.buyerId),
            body: renderReengageSms({ firstName: cand.firstName, cut: cand.cut, link: `${SITE_URL}/member` }),
            reason: 'loss-recovery-reengage',
          });
          if (ok) smsSent++;
        }
      } else if (cand.action === 'downsell') {
        const res = await sendLossRecoveryDownsell({ firstName: cand.firstName, email: cand.email, cut: cand.cut });
        if (res.success) done.downsell++;
        else suppressed++;
      } else {
        // nurture: NO email now. Single scheduled-style stamp the existing
        // rails already read: re-warm-cohort reanimates unengaged buyers 60d
        // after 'Warmup Sent At' (lifetime 2-attempt cap + suppression are
        // that cron's job); 'nudged' suppresses rancher-launch-warmup's own
        // day-7 nudge so the buyer hears nothing until then.
        if (cand.rewarmStamp) {
          await updateRecord(TABLES.CONSUMERS, cand.buyerId, {
            'Warmup Sent At': new Date().toISOString(),
            'Warmup Stage': 'nudged',
          });
        }
        done.nurture++;
      }
    } catch (e: any) {
      errors.push(`${cand.referralId}: ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
    await new Promise((r) => setTimeout(r, PACING_MS));
  }

  const touched = done.reengage + done.downsell + done.nurture;
  if (touched > 0 || errors.length > 0) {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🪃 <b>loss recovery</b> — <b>${touched}</b> recovered touch${touched === 1 ? '' : 'es'}\n\n` +
        `re-engage ${done.reengage} (+${smsSent} sms) · downsell ${done.downsell} · nurture-stamp ${done.nurture}` +
        `${suppressed ? ` · ${suppressed} suppressed/capped` : ''}${errors.length ? ` · ${errors.length} errors` : ''}` +
        `${sel.capped ? ` · ${sel.capped} over cap (tomorrow)` : ''}${timeBoxed ? ' · time-boxed' : ''}\n` +
        `reasons seen: ${fmtCounts(sel.reasonCounts)}`,
    ).catch(() => {});
  }

  return {
    status: errors.length || timeBoxed ? 'partial' : 'success',
    recordsTouched: touched,
    notes:
      `pool=${candidates.length} planned=${sel.planned.length} reengage=${done.reengage} sms=${smsSent} ` +
      `downsell=${done.downsell} nurture=${done.nurture} suppressed=${suppressed} cap=${cap} capped=${sel.capped} ` +
      `reasons={${fmtCounts(sel.reasonCounts)}} errs=${errors.length}` +
      (errors.length ? ` err1=${errors[0].slice(0, 80)}` : '') + (timeBoxed ? ' timeBoxed' : ''),
    skipReasonBreakdown: { ...sel.skips, ...(suppressed ? { 'send-suppressed-or-capped': suppressed } : {}) },
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('loss-recovery', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
