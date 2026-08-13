// app/api/cron/applied-chase/route.ts
//
// APPLIED-COHORT CHASE RAIL — daily 14:40 UTC (before rancher-followup's
// 15:10 and onboarding-stuck's 16:15, so this rail's cross-rail stamp wins
// the day and the incumbents defer instead of double-touching).
//
// WHO/WHY: fresh Rancher applications (Onboarding Status blank or 'Docs
// Sent', agreement unsigned, not parked/broker/self-submit/escalated) get a
// day-0 welcome + one-click sign link, a day-2 nudge, a day-5 last call,
// then a handoff to the human dial list (Stuck Escalated At/Bucket — the
// exact stamp /admin/today's stuck-rancher queue keys on). Selector + plan
// logic is pure and unit-tested in lib/appliedChase.ts — read its header for
// the cohort contract and the cross-rail dedup design.
//
// SAFETY STACK:
//   • Tri-state APPLIED_CHASE_ENABLED, FAIL-TO-OFF: unset/anything → off
//     (handler logs 'disabled' and exits — gate INSIDE realHandler so a
//     daily Cron Runs row always lands and EXPECTED_CRONS_24H stays honest,
//     the demand-router/campaign-autopilot pattern). 'dry-run' = full
//     selection + logged plan, ZERO sends, ZERO writes. 'true' = live.
//   • Cap 20 touches/run (lib/appliedChase), oldest application first — the
//     first live sweep over the backlog is bounded and ordered by neglect.
//   • Claim-before-send: the stage stamp lands BEFORE the email (the
//     rancher-onboarding-drip P0 pattern), with best-effort rollback on a
//     thrown send so the step retries instead of skipping ahead unsent.
//   • Cross-rail quiet: honors + stamps the shared 'Last Onboarding Nudge
//     At' so this rail, rancher-followup, and onboarding-stuck never stack
//     touches inside 48h.
//
// SCHEMA (BEN: create fields on Ranchers before flipping live):
//   'Applied Chase Stage'         — singleSelect or text
//   'Applied Chase Last Touch At' — dateTime
// updateRecord auto-strips unknown fields (with a per-field operator
// alert), so a missing field degrades to "stage never persists → the row
// re-selects after the 48h quiet window" — bounded, but create the fields
// first so touches are one-shot. 'Stuck Escalated At'/'Stuck Escalated
// Bucket' and 'Last Onboarding Nudge At' already exist (written daily by the
// incumbent chase crons).

import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { excludeBrokerRanchers } from '@/lib/brokerRail';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { JWT_SECRET } from '@/lib/secrets';
import jwt from 'jsonwebtoken';
import {
  sendAppliedChaseDay0,
  sendAppliedChaseDay2,
  sendAppliedChaseDay5,
} from '@/lib/email';
import {
  appliedChaseMode,
  planAppliedChase,
  APPLIED_CHASE_MAX_TOUCHES_PER_RUN,
  APPLIED_CHASE_STAGE_FIELD,
  APPLIED_CHASE_TOUCH_AT_FIELD,
  LAST_ONBOARDING_NUDGE_FIELD,
  type AppliedChaseAction,
} from '@/lib/appliedChase';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

/** One-click agreement-signing link — same mint as resend-agreement /
 * send-onboarding / the email-sequences reminder (30d, type
 * 'agreement-signing'; app/api/ranchers/sign-agreement verifies). Minted per
 * send, never stored. */
function mintSignUrl(rancherId: string): string {
  const token = jwt.sign({ type: 'agreement-signing', rancherId }, JWT_SECRET, {
    expiresIn: '30d',
  });
  return `${SITE_URL}/rancher/sign-agreement?token=${token}`;
}

const SENDERS = {
  day0: sendAppliedChaseDay0,
  day2: sendAppliedChaseDay2,
  day5: sendAppliedChaseDay5,
} as const;

interface CronResult {
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}

async function realHandler(_request: Request): Promise<CronResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const mode = appliedChaseMode(process.env.APPLIED_CHASE_ENABLED);
  if (mode === 'off') {
    return {
      status: 'success',
      recordsTouched: 0,
      notes:
        "disabled: APPLIED_CHASE_ENABLED is not 'true' or 'dry-run' (fail-to-off) — no selection, no sends",
    };
  }

  // BROKER RAIL: represented ranchers never applied — Ben recruited them and
  // sells for them. Their blank Onboarding Status is the designed end state;
  // chasing them for a signature they were never sent is the exact bug every
  // chase cron's broker skip-list exists to prevent.
  const ranchers = excludeBrokerRanchers((await getAllRecords(TABLES.RANCHERS)) as any[]);
  // P4c: 0 rows from a table that always holds ~80 = a degraded/empty read.
  // Return 'partial' so withCronRun alerts instead of logging a green no-op.
  if (!Array.isArray(ranchers) || ranchers.length === 0) {
    return {
      status: 'partial',
      recordsTouched: 0,
      notes: 'ranchers read returned 0 rows — degraded/empty; not chasing on a blind read',
    };
  }

  const plan = planAppliedChase(ranchers, Date.now(), {
    maxTouches: APPLIED_CHASE_MAX_TOUCHES_PER_RUN,
  });
  const counts = { day0: 0, day2: 0, day5: 0, handoff: 0 } as Record<string, number>;
  for (const a of plan.actions) counts[a.kind === 'handoff' ? 'handoff' : a.touch!]++;
  const baseNote = `day0=${counts.day0} day2=${counts.day2} day5=${counts.day5} handoff=${counts.handoff} stops=${plan.stops.length}`;

  if (mode === 'dry-run') {
    for (const a of plan.actions) {
      console.info(
        `[applied-chase] DRY-RUN would ${a.kind === 'handoff' ? 'hand off' : `send ${a.touch}`}: ` +
          `${a.ranchName} (${a.state || '?'}) age=${a.ageDays}d stage='${a.priorStage}'` +
          (a.emailDead ? ' [email channel dead]' : ''),
      );
    }
    for (const s of plan.stops) {
      console.info(`[applied-chase] DRY-RUN would stop: ${s.ranchName} — ${s.reason}`);
    }
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `DRY-RUN (APPLIED_CHASE_ENABLED='dry-run') — would touch ${plan.actions.length}: ${baseNote}`,
      skipReasonBreakdown: plan.skips,
    };
  }

  // ── LIVE ──────────────────────────────────────────────────────────────────
  let sent = 0;
  let handedOff = 0;
  let stopped = 0;
  let failed = 0;
  const summaryLines: string[] = [];

  // Stop-flips first: rows this rail claimed that have since left the cohort.
  for (const s of plan.stops) {
    try {
      await updateRecord(TABLES.RANCHERS, s.id, { [APPLIED_CHASE_STAGE_FIELD]: 'stopped' });
      stopped++;
    } catch (e: any) {
      console.error('[applied-chase] stop flip failed:', s.id, e?.message);
    }
  }

  for (const a of plan.actions as AppliedChaseAction[]) {
    const nowIso = new Date().toISOString();

    if (a.kind === 'handoff') {
      // Hand to the human dial list. Stamping Stuck Escalated At/Bucket is
      // what puts the row on /admin/today's stuck-rancher queue (outcomeKind
      // 'rancher'); the bucket is the DERIVED one so lib/stuckRancherQueue
      // never flags drift. Both incumbent crons' day-14 escalations check
      // this same stamp, so neither will re-escalate on top of it.
      try {
        await updateRecord(TABLES.RANCHERS, a.id, {
          'Stuck Escalated At': nowIso,
          'Stuck Escalated Bucket': a.bucket,
          [APPLIED_CHASE_STAGE_FIELD]: 'handed-off',
          [APPLIED_CHASE_TOUCH_AT_FIELD]: nowIso,
        });
        handedOff++;
        summaryLines.push(
          `  · ${a.ranchName} — handed to dial list (${a.bucket}${a.emailDead ? ', email dead' : ''}, ${a.ageDays}d old)`,
        );
      } catch (e: any) {
        failed++;
        console.error('[applied-chase] handoff stamp failed:', a.id, e?.message);
      }
      continue;
    }

    // SEND — claim before sending (drip P0 pattern): stage + touch stamps +
    // the shared cross-rail throttle land first. A claim that throws means
    // we DON'T send (sending unclaimed re-sends next run); a thrown send
    // rolls the stage back so the step retries instead of skipping ahead.
    try {
      await updateRecord(TABLES.RANCHERS, a.id, {
        [APPLIED_CHASE_STAGE_FIELD]: a.nextStage,
        [APPLIED_CHASE_TOUCH_AT_FIELD]: nowIso,
        [LAST_ONBOARDING_NUDGE_FIELD]: nowIso,
      });
    } catch (stampErr: any) {
      failed++;
      console.error(
        `[applied-chase] claim stamp failed for ${a.id} — skipping send:`,
        stampErr?.message,
      );
      continue;
    }
    try {
      const result = await SENDERS[a.touch!]({
        to: a.email,
        ranchName: a.ranchName,
        operatorName: a.operatorName,
        signUrl: mintSignUrl(a.id),
        pitchUrl: `${SITE_URL}/pitch`,
        rancherId: a.id,
      });
      if (result?.suppressed) {
        // Claim stays — a suppressed recipient shouldn't be retried daily.
        console.warn(`[applied-chase] ${a.touch} suppressed for ${a.id}:`, result.reason);
        continue;
      }
      if (!result?.success) {
        throw new Error(result?.reason || 'send failed');
      }
      sent++;
      summaryLines.push(`  · ${a.ranchName} — ${a.touch} sent (${a.ageDays}d old)`);
    } catch (sendErr: any) {
      failed++;
      console.error(
        `[applied-chase] ${a.touch} send failed for ${a.id} after claim — rolling back stage:`,
        sendErr?.message,
      );
      // Best-effort rollback; the cross-rail stamp stays (conservative:
      // suppressing other rails for 48h beats double-mailing the rancher).
      try {
        await updateRecord(TABLES.RANCHERS, a.id, {
          [APPLIED_CHASE_STAGE_FIELD]: a.priorStage,
        });
      } catch (rollbackErr: any) {
        console.error('[applied-chase] stage rollback failed:', a.id, rollbackErr?.message);
      }
    }
  }

  if ((sent || handedOff || stopped) && TELEGRAM_ADMIN_CHAT_ID) {
    try {
      const lines = [
        `🧲 <b>Applied-cohort chase</b>`,
        `Sent: ${sent} · Handed to dial list: ${handedOff} · Stopped: ${stopped}${failed ? ` · Failed: ${failed}` : ''}`,
        ...summaryLines,
      ];
      await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, lines.join('\n'));
    } catch (e: any) {
      console.error('[applied-chase] telegram summary failed:', e?.message);
    }
  }

  return {
    // A run where every attempted touch failed should alert, not read green.
    status: failed > 0 && sent + handedOff === 0 ? 'partial' : 'success',
    recordsTouched: sent + handedOff + stopped,
    notes: `mode=live sent=${sent} handoff=${handedOff} stopped=${stopped} failed=${failed} · planned: ${baseNote}`,
    skipReasonBreakdown: plan.skips,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('applied-chase', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
