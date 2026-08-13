// app/api/cron/pipeline-sla/route.ts
//
// PIPELINE-SLA — daily 13:20 UTC (after referral-stale-expiry's 13:10 frees
// the genuinely dead rows, before the 14:xx cockpit-feeding rails, so an
// escalation stamped here is on /admin/today the same morning).
//
// Every open deal stage gets a clock, an owner, and an escalation. The
// matrix, the clock bases, and the covered-elsewhere exclusion list live in
// lib/pipelineSla.ts — read that header first; this route is the thin shell
// (auth, gate, Airtable IO, stamps, signals).
//
// WHAT AN ESCALATION IS: stamp 'Stuck Escalated At' + 'Stuck Escalated
// Bucket' on the record (money-truth: the escalation is persisted, not just
// logged — the same dial-list plumbing #608's applied-chase handoff uses),
// plus ONE sendOperatorSignal for the 'loud' class (Slot Locked — money may
// already be collected). ZERO buyer/rancher sends, ever, in any mode.
//
// TWO PASSES, ONE CAP (25/run, referrals first — money first):
//   1. Referral stage escalations per STAGE_SLA_MATRIX.
//   2. Rancher paused-review: Active Status='Paused' with pause evidence
//      >30d (or undatable — the forever-pause case) → dial-list stamp with
//      bucket 'paused-review', re-escalated at most every 30d.
//
// SAFETY STACK (the applied-chase / deposit-watchdog patterns, verbatim):
//   • Tri-state PIPELINE_SLA_ENABLED, FAIL-TO-OFF: unset/anything → off
//     (gate INSIDE realHandler so a daily Cron Runs row always lands and
//     EXPECTED_CRONS_24H stays honest). 'dry-run' = full selection + logged
//     plan, ZERO writes, ZERO signals. 'true' = live.
//   • Idempotent: a row stamped inside RE_ESCALATE_COOLDOWN_DAYS (14d
//     referrals / 30d paused-review) is never re-escalated.
//   • CLAIM-BEFORE-SIGNAL + verify-persist: the stamp lands BEFORE the loud
//     signal, and if it did not persist (field missing on Referrals →
//     updateRecord silently strips) the pass ABORTS — no cooldown stamp =
//     no signals, never a daily re-escalation loop.
//
// SCHEMA (BEN: create on REFERRALS before flipping live — both already exist
// on Ranchers):
//   'Stuck Escalated At'     — dateTime
//   'Stuck Escalated Bucket' — singleLineText (or a singleSelect that carries
//     every STAGE_SLA_MATRIX bucket value; on Ranchers add the
//     'paused-review' choice if that field is a singleSelect)

import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { excludeBrokerRanchers } from '@/lib/brokerRail';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import {
  pipelineSlaMode,
  selectPipelineSlaEscalations,
  pipelineSlaSkipBreakdown,
  selectPausedReviews,
  pausedReviewSkipBreakdown,
  STAGE_SLA_MATRIX,
  STUCK_ESCALATED_AT_FIELD,
  STUCK_ESCALATED_BUCKET_FIELD,
  PIPELINE_SLA_MAX_PER_RUN,
  PAUSED_REVIEW_BUCKET,
  PAUSED_REVIEW_DAYS,
  RE_ESCALATE_COOLDOWN_DAYS,
} from '@/lib/pipelineSla';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

interface CronResult {
  status: 'success' | 'partial' | 'error' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}

const str = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'object' && 'name' in (v as any)) return String((v as any).name ?? '');
  return String(v);
};

async function realHandler(_request: Request): Promise<CronResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const mode = pipelineSlaMode(process.env.PIPELINE_SLA_ENABLED);
  if (mode === 'off') {
    return {
      status: 'success',
      recordsTouched: 0,
      notes:
        "disabled: PIPELINE_SLA_ENABLED is not 'true' or 'dry-run' (fail-to-off) — no selection, no writes",
    };
  }

  const now = Date.now();

  // Server-side filter to the clocked stages only. The formula references
  // {Status} alone — never a field that may not exist (the deposit-accept-sla
  // unknown-field-kills-the-query lesson). No fields projection for the same
  // reason: the two Stuck Escalated fields are NEW on Referrals and a
  // projection naming an unknown field 422s the whole read.
  const statusFormula =
    'OR(' + STAGE_SLA_MATRIX.map((s) => `{Status} = "${s.status}"`).join(', ') + ')';
  let refs: any[] = [];
  try {
    refs = (await getAllRecords(TABLES.REFERRALS, statusFormula)) as any[];
  } catch (e: any) {
    return {
      status: 'error',
      recordsTouched: 0,
      notes: `referrals read failed: ${e?.message?.slice(0, 160) || 'unknown'}`,
    };
  }

  // BROKER RAIL: represented ranchers are deliberately configured by Ben
  // (Rusty OFF Connect by design, REP routing OFF) — a "re-review this
  // pause" dial for them is noise. Same exclusion applied-chase uses.
  let ranchers: any[] = [];
  try {
    ranchers = excludeBrokerRanchers((await getAllRecords(TABLES.RANCHERS)) as any[]);
  } catch (e: any) {
    // The referral pass can still run — degrade, report partial below.
    console.error('[pipeline-sla] ranchers read failed:', e?.message);
  }

  const escalations = selectPipelineSlaEscalations(refs, now, PIPELINE_SLA_MAX_PER_RUN);
  const pausedCap = Math.max(0, PIPELINE_SLA_MAX_PER_RUN - escalations.length);
  const pausedReviews = selectPausedReviews(ranchers, now, pausedCap);

  const breakdown: Record<string, number> = {
    ...pipelineSlaSkipBreakdown(refs, now),
    ...pausedReviewSkipBreakdown(ranchers, now),
  };

  const fmtRef = (e: (typeof escalations)[number]) =>
    `${e.sla.status} · day ${e.ageDays} (${e.sla.escalation}) ref=${e.ref.id}`;
  const fmtPaused = (p: (typeof pausedReviews)[number]) =>
    `paused ${p.pausedDays === null ? '?(undatable)' : `${p.pausedDays}d`} rancher=${p.rancher.id}`;

  if (mode === 'dry-run') {
    for (const e of escalations) console.info(`[pipeline-sla] DRY-RUN would escalate: ${fmtRef(e)}`);
    for (const p of pausedReviews) console.info(`[pipeline-sla] DRY-RUN would review: ${fmtPaused(p)}`);
    return {
      status: 'success',
      recordsTouched: 0,
      notes:
        `DRY-RUN (PIPELINE_SLA_ENABLED='dry-run') — would escalate ${escalations.length} ` +
        `referral${escalations.length === 1 ? '' : 's'} + ${pausedReviews.length} paused-review ` +
        `(scanned refs=${refs.length} ranchers=${ranchers.length})`,
      skipReasonBreakdown: breakdown,
    };
  }

  // ── LIVE ──────────────────────────────────────────────────────────────────
  const errors: string[] = [];
  let stamped = 0;
  let signaled = 0;
  let reviewed = 0;

  // PASS 1 — referral stage escalations. Stamp first (claim-before-signal),
  // verify-persist, THEN the loud signal for the money class.
  for (const e of escalations) {
    const refId = String(e.ref.id);
    try {
      const updated: any = await updateRecord(TABLES.REFERRALS, refId, {
        [STUCK_ESCALATED_AT_FIELD]: new Date().toISOString(),
        [STUCK_ESCALATED_BUCKET_FIELD]: e.sla.bucket,
      });
      if (!updated || !updated[STUCK_ESCALATED_AT_FIELD]) {
        // Field missing on Referrals → updateRecord stripped it. No stamp =
        // no cooldown = tomorrow re-escalates + re-signals forever. ABORT
        // the whole referral pass (deposit-watchdog's fields-missing abort).
        return {
          status: 'error',
          recordsTouched: stamped + reviewed,
          notes:
            `ABORT: escalation stamp did not persist for ${refId} — create "${STUCK_ESCALATED_AT_FIELD}" ` +
            `(dateTime) + "${STUCK_ESCALATED_BUCKET_FIELD}" (text) on Referrals. stampedBeforeAbort=${stamped}`,
          skipReasonBreakdown: breakdown,
        };
      }
    } catch (err: any) {
      errors.push(`${refId}: stamp (${err?.message?.slice(0, 60) || 'unknown'})`);
      continue;
    }
    stamped++;

    if (e.sla.escalation === 'loud') {
      // Money may already be collected (Slot Locked = post-accept, deposit
      // normally paid) and the deal has sat past every clock. One loud card;
      // the At-stamp is the primary throttle, the dedupeKey the belt.
      const buyerName = str((e.ref as any)['Buyer Name']).trim() || 'a buyer';
      const buyerState = str((e.ref as any)['Buyer State']).trim();
      const rancherName = str((e.ref as any)['Suggested Rancher Name']).trim() || 'the rancher';
      try {
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'payout',
          summary: `${e.sla.status} for ${e.ageDays}d — ${buyerName} — money may be collected`,
          detail:
            `${buyerName}${buyerState ? ` (${buyerState})` : ''} · rancher=${rancherName} · referral=${refId}\n` +
            `Sat at ${e.sla.status} ${e.ageDays} days (SLA ${e.sla.maxAgeDays}d, clock: ${e.sla.basis}). ` +
            `Deal is on the dial list — call the rancher or the buyer today.\n` +
            `${SITE_URL}/admin/desk/${refId}`,
          refs: [{ type: 'referral', id: refId }],
          dedupeKey: `pipeline-sla-${refId}`,
          dedupeWindowMs: (RE_ESCALATE_COOLDOWN_DAYS - 1) * 24 * 60 * 60 * 1000,
        });
        signaled++;
      } catch (err: any) {
        // Stamp already landed — the dial list has the row; a lost card is
        // recoverable, a re-ping loop is not.
        errors.push(`${refId}: signal (${err?.message?.slice(0, 60) || 'unknown'})`);
      }
      await new Promise((r) => setTimeout(r, 300)); // pace Telegram
    }
    await new Promise((r) => setTimeout(r, 150)); // pace Airtable
  }

  // PASS 2 — rancher paused-review. Dial-list stamp only, no signals: the
  // row surfaces on /admin/today's stuck-rancher queue (bucket
  // 'paused-review' passes the parked filter — lib/stuckRancherQueue).
  for (const p of pausedReviews) {
    const rid = String(p.rancher.id);
    try {
      const updated: any = await updateRecord(TABLES.RANCHERS, rid, {
        [STUCK_ESCALATED_AT_FIELD]: new Date().toISOString(),
        [STUCK_ESCALATED_BUCKET_FIELD]: PAUSED_REVIEW_BUCKET,
      });
      if (!updated || str(updated[STUCK_ESCALATED_BUCKET_FIELD]) !== PAUSED_REVIEW_BUCKET) {
        // Bucket dropped ⇒ the Ranchers field is a singleSelect without a
        // 'paused-review' choice — every further write fails identically
        // (and updateRecord already fired its own per-field alert), so
        // abort the pass instead of alerting 25 times.
        errors.push(
          `${rid}: paused-review bucket did not persist — add the '${PAUSED_REVIEW_BUCKET}' choice to ` +
            `Ranchers."${STUCK_ESCALATED_BUCKET_FIELD}"; paused pass aborted`,
        );
        break;
      }
      reviewed++;
    } catch (err: any) {
      errors.push(`${rid}: paused-review stamp (${err?.message?.slice(0, 60) || 'unknown'})`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: stamped + reviewed,
    notes:
      `escalated=${stamped} (loud=${signaled}) pausedReview=${reviewed}/${pausedReviews.length} ` +
      `scanned refs=${refs.length} ranchers=${ranchers.length} ` +
      `cooldown=${RE_ESCALATE_COOLDOWN_DAYS}d/${PAUSED_REVIEW_DAYS}d errs=${errors.length}` +
      (errors.length ? ` err1=${errors[0].slice(0, 100)}` : ''),
    skipReasonBreakdown: breakdown,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('pipeline-sla', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
