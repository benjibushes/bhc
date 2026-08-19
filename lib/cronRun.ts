import { createRecord, getAllRecords, updateRecord, TABLES, escapeAirtableValue } from './airtable';
import { sendOperatorSignal } from './operatorSignal';
import { mergeCronRunRollup, heartbeatPatch, rollupDayKey } from './cronRunRollup';

type CronStatus = 'success' | 'partial' | 'error' | 'maintenance-blocked' | 'paused';

interface CronRunResult {
  status: CronStatus;
  recordsTouched?: number;
  notes?: string;
  /**
   * Optional JSON-serializable map of {skip reason: count}. Persisted to the
   * `Skip Reason Breakdown` field on the Cron Runs row so day-over-day diffs
   * reveal real signal vs noise. Cron's that gate records (batch-approve,
   * referral-chasup, etc) should populate this so the operator can see WHY
   * the queue isn't draining.
   */
  skipReasonBreakdown?: Record<string, number>;
  /**
   * RETIRED (capacity audit 2026-08-19) — accepted for compatibility, ignored.
   *
   * This suppressed the Cron Runs row on pure no-op runs because those rows
   * were 31% of log inflow. Rows are now rolled up one-per-cron-per-UTC-day
   * (lib/cronRunRollup), so a no-op run costs ZERO new records — it just
   * increments `Run Count` on the day's existing row. Suppressing it now
   * would only make that count lie about how often the cron actually fired.
   *
   * Handlers may keep returning it; removing it from ~55 routes is a separate
   * mechanical sweep.
   */
  skipLog?: boolean;
}

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

// Alert-integrity fix (runtime audit 2026-07-28): this was a raw Telegram
// fetch — response unchecked, silently skipped when the bot token was unset.
// Now rides sendOperatorSignal: delivery is verified, a failed Telegram wire
// falls back to SMS/email on loud, and dedupe (in-memory + Redis claimOnce)
// replaces the old per-instance cooldown map with a fleet-wide window.
async function maybeAlertOperator(cron: string, status: CronStatus, notes: string): Promise<void> {
  if (status !== 'error' && status !== 'partial') return;
  try {
    await sendOperatorSignal({
      // error = loud (SMS/email fallback if Telegram is down); partial = normal.
      urgency: status === 'error' ? 'loud' : 'normal',
      kind: 'system-error',
      summary: `CRON ${status.toUpperCase()} · ${cron}`,
      detail: notes.slice(0, 500),
      refs: [{ type: 'cron', id: cron }],
      dedupeKey: `cron-${status}:${cron}`,
      dedupeWindowMs: ALERT_COOLDOWN_MS,
    });
  } catch (e: any) {
    // sendOperatorSignal is designed never to throw; belt-and-suspenders so
    // an alerting failure can never mask the cron's own result.
    console.warn(`[withCronRun:${cron}] alert send failed:`, e?.message);
  }
}

/**
 * Today's rollup row for this cron, or null when there isn't one yet.
 *
 * Throws on a read failure ON PURPOSE: the caller catches and falls back to a
 * plain append, so a bad read degrades to "an extra row" and never to "no row"
 * — a missing row is what the dead-man's switch reads as a dead cron.
 */
async function findDayRow(name: string, dayKey: string): Promise<any | null> {
  const rows = (await getAllRecords(
    TABLES.CRON_RUNS,
    `AND({Name}="${escapeAirtableValue(name)}", {Run Day}="${escapeAirtableValue(dayKey)}")`,
  )) as any[];
  if (!rows || rows.length === 0) return null;
  // Two rows for one cron-day means two executions raced the create (no
  // cross-instance lock; same-name overlap is rare). Keep merging into the
  // newest: counts split across the pair, but the dead-man still sees a fresh
  // stamp and the extra row ages out with retention.
  rows.sort(
    (a, b) =>
      new Date(b['Started At'] || 0).getTime() - new Date(a['Started At'] || 0).getTime(),
  );
  return rows[0];
}

/**
 * Wraps a cron handler. Logs start, awaits the function, logs end with
 * status + duration + records-touched count. On exception, records the
 * error message and re-throws so Vercel marks the cron failed.
 *
 * Usage inside a cron route:
 *
 *   async function handler(request: Request): Promise<CronRunResult> {
 *     // ... logic ...
 *     return { status: 'success', recordsTouched: 5, notes: 'Chased 5 stale' };
 *   }
 *   export const GET = withCronRun('referral-chasup', handler);
 *
 * Wrapper writes to Airtable table 'Cron Runs'. Failures to log don't
 * block the cron — they just console.error.
 */
export function withCronRun<T extends CronRunResult>(
  name: string,
  fn: (request: Request) => Promise<T>,
  opts?: {
    /**
     * Scale audit 2026-07-22: a Vercel maxDuration kill terminates the lambda
     * before `finally` runs — a mid-batch death left NO Cron Runs row and no
     * alarm, and the 25h dead-man never flags an hourly cron (the next tick
     * writes a row). With heartbeat:true a 'started' row is written BEFORE
     * the handler and UPDATED to completion in finally; a row stuck at
     * 'started' >2h = killed mid-run, flagged by daily-health-digest.
     * Opt-in (the long-running hourly campaign crons) so the other ~55 crons
     * don't pay a second Airtable write per run.
     */
    heartbeat?: boolean;
  },
): (request: Request) => Promise<Response> {
  return async function wrapped(request: Request): Promise<Response> {
    const startedAt = new Date();
    let endedAt: Date = startedAt;
    let status: CronStatus = 'error';
    let recordsTouched = 0;
    let notes = '';
    let skipReasonBreakdown: Record<string, number> | undefined;
    let returnedResponse: Response | null = null;
    let heartbeatRowId: string | null = null;
    if (opts?.heartbeat) {
      try {
        // Mark the day's row in-progress. heartbeatPatch touches ONLY the
        // freshness + status fields, so a mid-day kill leaves a row stuck at
        // 'started' for daily-health-digest to flag (the point of heartbeat
        // mode) without resetting the totals earlier runs accumulated.
        const dayKey = rollupDayKey(startedAt.toISOString());
        const existing = dayKey ? await findDayRow(name, dayKey) : null;
        if (existing?.id) {
          await updateRecord(
            TABLES.CRON_RUNS,
            existing.id,
            heartbeatPatch(startedAt.toISOString()),
          );
          heartbeatRowId = existing.id;
        } else {
          const started = await createRecord(TABLES.CRON_RUNS, {
            Name: name,
            ...heartbeatPatch(startedAt.toISOString()),
            // Zeroed so the finally-block merge counts this run as the first,
            // rather than adding to an undefined.
            'Records Touched': 0,
            'Run Count': 0,
            'Errors': 0,
            Notes: 'heartbeat — run in progress',
          });
          heartbeatRowId = (started as any)?.id || null;
        }
      } catch (hbErr: any) {
        // Best-effort: no heartbeat row just degrades to the old behavior
        // (row written only in finally).
        console.error(`[withCronRun:${name}] heartbeat write failed:`, hbErr?.message);
      }
    }
    try {
      // Pause gate: if a Cron Pauses row exists with Paused=true matching
      // this cron's name, short-circuit. Operator controls via Telegram
      // /pausecron + /resumecron.
      try {
        const pauses = (await getAllRecords(
          TABLES.CRON_PAUSES,
          `AND({Name}="${escapeAirtableValue(name)}", {Paused}=TRUE())`,
        )) as any[];
        if (pauses.length > 0) {
          const reason = pauses[0]['Reason'] || 'paused via Telegram';
          const by = pauses[0]['Paused By'] || 'operator';
          status = 'paused';
          recordsTouched = 0;
          notes = `paused by ${by}: ${reason}`.slice(0, 500);
          returnedResponse = new Response(
            JSON.stringify({ ok: true, status, recordsTouched, notes }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
          // Skip body; finally-block still writes the Cron Runs row so the
          // operator can SEE that the pause did its job.
          return returnedResponse;
        }
      } catch (pauseErr: any) {
        // Don't let a pause-table read error break the cron — log + proceed.
        console.error(`[withCronRun:${name}] pause check failed:`, pauseErr?.message);
      }

      const result = await fn(request);
      status = result.status;
      recordsTouched = result.recordsTouched ?? 0;
      notes = result.notes ?? '';
      skipReasonBreakdown = result.skipReasonBreakdown;
      returnedResponse = new Response(
        JSON.stringify({ ok: true, status, recordsTouched, notes }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    } catch (e: any) {
      status = 'error';
      notes = (e?.message || String(e)).slice(0, 500);
      returnedResponse = new Response(
        JSON.stringify({ ok: false, error: notes }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    } finally {
      endedAt = new Date();
      // ROLLUP (capacity audit 2026-08-19). One row per cron per UTC day
      // instead of one per execution: Cron Runs was 11,231 rows / 73 crons /
      // 31 days = 22% of the base's 50,000-record cap, and nothing reads a
      // single execution — every consumer collapses to most-recent-per-name
      // first. Merge rules + what they protect live in lib/cronRunRollup.
      //
      // The no-op suppression this block used to run (skipLog + a once-daily
      // Redis claim) is retired: it existed to stop row growth, which the
      // rollup now solves structurally, and skipping the write would only
      // make `Run Count` under-report how often the cron fired.
      const observation = {
        name,
        startedAtISO: startedAt.toISOString(),
        endedAtISO: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        status,
        recordsTouched,
        notes,
        skipReasonBreakdown,
      };
      let rolledUp = false;
      try {
        const dayKey = rollupDayKey(observation.startedAtISO);
        if (dayKey) {
          // Re-read rather than trusting heartbeatRowId's stale field values:
          // another instance may have merged into this row since.
          const existing = await findDayRow(name, dayKey);
          const fields = mergeCronRunRollup(existing, observation);
          if (existing?.id) await updateRecord(TABLES.CRON_RUNS, existing.id, fields);
          else await createRecord(TABLES.CRON_RUNS, fields);
          rolledUp = true;
        }
      } catch (rollupErr: any) {
        console.error(
          `[withCronRun:${name}] rollup upsert failed, falling back to append:`,
          rollupErr?.message,
        );
      }
      if (!rolledUp) {
        // FALLBACK: plain append, exactly the pre-rollup behaviour. A rollup
        // failure must never cost the run its row — a missing row is what the
        // dead-man's switch reads as a dead cron.
        try {
          const row: Record<string, unknown> = {
            Name: name,
            'Started At': observation.startedAtISO,
            'Ended At': observation.endedAtISO,
            'Duration ms': observation.durationMs,
            Status: status,
            'Records Touched': recordsTouched,
            Notes: notes,
          };
          if (skipReasonBreakdown && Object.keys(skipReasonBreakdown).length > 0) {
            row['Skip Reason Breakdown'] = JSON.stringify(skipReasonBreakdown);
          }
          if (heartbeatRowId) {
            try {
              await updateRecord(TABLES.CRON_RUNS, heartbeatRowId, row);
            } catch {
              await createRecord(TABLES.CRON_RUNS, row);
            }
          } else {
            await createRecord(TABLES.CRON_RUNS, row);
          }
        } catch (logErr: any) {
          console.error(`[withCronRun:${name}] log write failed:`, logErr?.message);
        }
      }
      await maybeAlertOperator(name, status, notes);
    }
    return returnedResponse!;
  };
}
