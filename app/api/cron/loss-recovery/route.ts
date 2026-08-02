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
// SEQUENCING: PR #396 (the rancher-UI 'Loss Reason' writers) is MERGED — this
// rail selects real candidates from day one, in DRY-RUN until Ben flips
// LOSS_RECOVERY_ENABLED=true.
//
// ⚠ BACKFILL LANDMINE: the 14d window rides LAST_MODIFIED_TIME(), which
// refreshes on ANY field write. Bulk-backfilling 'Loss Reason' onto the
// ~1,460 historical Closed Lost/Dormant rows (or any mass Notes sweep) makes
// months-old losses look fresh and they'd drip out at cap/day with "your
// rancher tried to reach you" copy. Guards: (1) any backfill MUST pre-stamp
// 'Recovery Sent At' on rows that should never get outreach; (2) live runs
// REFUSE to send when the eligible pool exceeds LIVE_ELIGIBLE_SANITY_MAX —
// a spike that size is a mass edit, not organic closes; review the dry-run
// notes, pre-stamp, then re-enable.
//
// SAFETY STACK (each layer independent):
//   - pure selector gates: Closed Lost + known reason + once-only via
//     'Recovery Sent At' + 14d close window + suppression + no other active
//     referral + nurture only when the re-warm rail will actually wake the
//     buyer + one touch per buyer per run + cap.
//   - 14d window rides the Airtable read (IS_AFTER(LAST_MODIFIED_TIME(), …))
//     because 'Closed At' is often unstamped and Referrals has no
//     last-modified FIELD; if the formula is rejected the selector goes
//     conservative (parseable in-window 'Closed At' required).
//   - claim-before-send: 'Recovery Sent At' stamped + read-back verified
//     BEFORE any send; if the stamp doesn't persist the run ABORTS (a crash
//     burns one touch; a double-send is worse — the product-recovery lesson).
//   - failed ≠ suppressed (the 2026-07-14 dead-RESEND-key lesson): a send
//     that definitively did NOT go out ({error} from Resend) rolls the claim
//     stamp BACK (retry tomorrow), lands in errors[], and flips the run to
//     'partial' so the watchdogs fire. Suppression/frequency-cap keeps the
//     stamp (correct burn — the buyer is capped or unreachable, not lost).
//   - guardedSend underneath: suppression list + 3/7d frequency cap + Email
//     Sends truth. SMS only via sendSMSToConsumer (TCPA gate) + isSmsWindow.
//   - 500ms pacing (Airtable 5 req/s) + soft deadline that exits honestly.

import { getAllRecords, updateRecord, isInvalidFilterFormulaError, TABLES } from '@/lib/airtable';
import { activeDealReferralsFormula } from '@/lib/cronReadFilters';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { shouldSendCronReport } from '@/lib/cronReportGate';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { sendSMSToConsumer } from '@/lib/twilio';
import { isSmsWindow } from '@/lib/sendWindow';
import { sendLossRecoveryReengage, sendLossRecoveryDownsell } from '@/lib/email';
import { isRancherOperationalForBuyers, getOperationalServedStates } from '@/lib/rancherEligibility';
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
// Live-mode circuit breaker: if selection finds more eligible touches than
// this in one day, that is a mass edit / 'Loss Reason' backfill refreshing
// LAST_MODIFIED_TIME() — not organic closes. Refuse to send; dry-run
// reporting still works so the spike is visible and reviewable.
const LIVE_ELIGIBLE_SANITY_MAX = 200;

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

  // Most days: no fresh Closed Lost rows carrying a Loss Reason → done.
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

  // Supply gate (2026-08-02, Ben's flip condition — "we shouldn't be routing
  // people if we have no supply there"): reengage touches only go to buyers
  // whose state has an operational rancher TODAY. Mirrors waiting-activation's
  // gate and FAILS CLOSED: if the ranchers read errors, coveredStates is empty
  // and every reengage skips ('reengage-no-supply') — downsell (/shop, ships
  // nationwide) and nurture (stamp only) are unaffected.
  const coveredStates = new Set<string>();
  try {
    const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
    for (const r of ranchers) {
      if (!isRancherOperationalForBuyers(r)) continue;
      for (const s of getOperationalServedStates(r)) coveredStates.add(s);
    }
  } catch (e: any) {
    console.error('[loss-recovery] ranchers read failed — supply gate fails closed:', e?.message);
  }

  const sel = selectLossRecovery({
    candidates,
    activeReferrals,
    consumersById,
    nowMs: runStartMs,
    windowDays: DEFAULT_WINDOW_DAYS,
    cap,
    windowEnforcedUpstream,
    coveredStates,
  });
  const byAction = { reengage: 0, downsell: 0, nurture: 0 } as Record<string, number>;
  for (const p of sel.planned) byAction[p.action]++;

  // ── DRY RUN (default): no sends, no stamps — would-send list in the notes ──
  if (!live) {
    const wouldSend = sel.planned.map((p) => `${p.referralId}:${p.action}`).join(', ');
    if (sel.planned.length > 0) {
      // Wave 1C: env-dark plan → log + Cron Runs note only (the notes below
      // carry the full would-send list). No Telegram for a rail that's off.
      console.info(
        `[loss-recovery] DRY RUN — would touch ${sel.planned.length} ` +
          `(re-engage ${byAction.reengage} · downsell ${byAction.downsell} · nurture-stamp ${byAction.nurture}` +
          `${sel.capped ? ` · ${sel.capped} over cap` : ''}) · reasons: ${fmtCounts(sel.reasonCounts)} — ` +
          `flip LOSS_RECOVERY_ENABLED=true to go live`,
      );
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
  // Circuit breaker BEFORE any send: an eligible pool this size means a mass
  // edit refreshed LAST_MODIFIED_TIME() (Loss Reason backfill, Notes sweep) —
  // months-old losses masquerading as fresh. Stop loudly; nothing is stamped.
  const eligibleTotal = sel.planned.length + sel.capped;
  if (eligibleTotal > LIVE_ELIGIBLE_SANITY_MAX) {
    // Loud + failover (Wave 1C transport migration): a halted live rail needs
    // operator action and must survive a dead bot token. Content unchanged.
    await sendOperatorSignal({
      urgency: 'loud',
      kind: 'system-error',
      summary: `loss recovery HALTED — ${eligibleTotal} eligible touches in one day (sanity max ${LIVE_ELIGIBLE_SANITY_MAX}).`,
      detail:
        `That's a mass edit / Loss Reason backfill, not organic closes. ` +
        `Nothing sent. Pre-stamp '${RECOVERY_SENT_AT_FIELD}' on backfilled rows (or review via dry-run) before re-enabling.`,
      dedupeKey: 'loss-recovery-halt',
      dedupeWindowMs: 6 * 60 * 60 * 1000,
    }).catch(() => {});
    return {
      status: 'error',
      recordsTouched: 0,
      notes:
        `HALT: eligible=${eligibleTotal} > sanity max ${LIVE_ELIGIBLE_SANITY_MAX} — mass-edit/backfill suspected ` +
        `(LAST_MODIFIED_TIME window dissolves under bulk writes). No sends, no stamps. ` +
        `Pre-stamp ${RECOVERY_SENT_AT_FIELD} on backfilled rows, then re-run.`,
      skipReasonBreakdown: { ...sel.skips, 'halted-eligible-over-sanity-max': eligibleTotal },
    };
  }

  const done = { reengage: 0, downsell: 0, nurture: 0 } as Record<string, number>;
  let smsSent = 0;
  let suppressed = 0;
  let failed = 0;
  let timeBoxed = false;
  const errors: string[] = [];

  // A send that came back { success:false, suppressed:false } definitively
  // did NOT go out (Resend RESOLVED with an error — the 2026-07-14 dead-key
  // mode). Burning the once-ever recovery touch on it would silently drop
  // the buyer from the rail forever while the run reported success. Roll the
  // claim back so tomorrow retries, and record a real error so the run goes
  // 'partial' and the watchdogs fire. If the rollback itself fails, the
  // stamp stays — the safe direction (never risks a double-send).
  const rollbackClaim = async (cand: LossRecoveryCandidate, why: string) => {
    failed++;
    errors.push(`${cand.referralId}: send-failed (${why.slice(0, 60)})`);
    try {
      await updateRecord(TABLES.REFERRALS, cand.referralId, {
        [RECOVERY_SENT_AT_FIELD]: null,
        Notes: cand.existingNotes,
      });
    } catch (e: any) {
      errors.push(`${cand.referralId}: rollback-failed (touch burned) ${e?.message?.slice(0, 60) || ''}`);
    }
  };

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
        if (res.success) {
          done.reengage++;
          // SMS leg: TCPA opt-in (re-checked by sendSMSToConsumer) + local window.
          if (cand.smsEligible && isSmsWindow(cand.state, Date.now())) {
            const ok = await sendSMSToConsumer({
              consumer: consumersById.get(cand.buyerId),
              body: renderReengageSms({ firstName: cand.firstName, cut: cand.cut, link: `${SITE_URL}/member` }),
              reason: 'loss-recovery-reengage',
            });
            if (ok) smsSent++;
          }
        } else if (res.suppressed) suppressed++; // frequency cap / list — correct burn
        else await rollbackClaim(cand, res.reason || 'resend-error');
      } else if (cand.action === 'downsell') {
        const res = await sendLossRecoveryDownsell({ firstName: cand.firstName, email: cand.email, cut: cand.cut });
        if (res.success) done.downsell++;
        else if (res.suppressed) suppressed++;
        else await rollbackClaim(cand, res.reason || 'resend-error');
      } else {
        // nurture: NO email now. Single scheduled-style stamp the existing
        // rails already read: re-warm-cohort reanimates unengaged buyers 60d
        // after 'Warmup Sent At' (lifetime 2-attempt cap + suppression are
        // that cron's job); 'nudged' suppresses rancher-launch-warmup's own
        // day-7 nudge so the buyer hears nothing until then. The selector
        // only plans nurture when shouldStampRewarm passed (full re-warm
        // filter mirror) — so the stamp is unconditional here.
        await updateRecord(TABLES.CONSUMERS, cand.buyerId, {
          'Warmup Sent At': new Date().toISOString(),
          'Warmup Stage': 'nudged',
        });
        done.nurture++;
      }
    } catch (e: any) {
      errors.push(`${cand.referralId}: ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
    await new Promise((r) => setTimeout(r, PACING_MS));
  }

  const touched = done.reengage + done.downsell + done.nurture;
  // Wave 1C transport migration: same gate (work or errors), now with dedupe
  // + SMS/email failover via sendOperatorSignal. Content unchanged.
  if (shouldSendCronReport({ workDone: touched, failures: errors.length })) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'recovery-suggestion',
      summary: `loss recovery — ${touched} recovered touch${touched === 1 ? '' : 'es'}`,
      detail:
        `re-engage ${done.reengage} (+${smsSent} sms) · downsell ${done.downsell} · nurture-stamp ${done.nurture}` +
        `${suppressed ? ` · ${suppressed} suppressed/capped` : ''}` +
        `${failed ? ` · ⚠ ${failed} SEND-FAILED (rolled back, retry tomorrow)` : ''}` +
        `${errors.length ? ` · ${errors.length} errors` : ''}` +
        `${sel.capped ? ` · ${sel.capped} over cap (tomorrow)` : ''}${timeBoxed ? ' · time-boxed' : ''}\n` +
        `reasons seen: ${fmtCounts(sel.reasonCounts)}`,
      dedupeKey: 'loss-recovery-summary',
      dedupeWindowMs: 6 * 60 * 60 * 1000,
    }).catch(() => {});
  }

  return {
    status: errors.length || timeBoxed ? 'partial' : 'success',
    recordsTouched: touched,
    notes:
      `pool=${candidates.length} planned=${sel.planned.length} reengage=${done.reengage} sms=${smsSent} ` +
      `downsell=${done.downsell} nurture=${done.nurture} suppressed=${suppressed} failed=${failed} cap=${cap} capped=${sel.capped} ` +
      `reasons={${fmtCounts(sel.reasonCounts)}} errs=${errors.length}` +
      (errors.length ? ` err1=${errors[0].slice(0, 80)}` : '') + (timeBoxed ? ' timeBoxed' : ''),
    skipReasonBreakdown: {
      ...sel.skips,
      ...(suppressed ? { 'send-suppressed-or-capped': suppressed } : {}),
      ...(failed ? { 'send-failed-rolled-back': failed } : {}),
    },
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('loss-recovery', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
