import { createRecord, getAllRecords, updateRecord, TABLES, escapeAirtableValue } from './airtable';
import { sendOperatorSignal } from './operatorSignal';
import { shouldWriteCronRunRow } from './cronRunPolicy';

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
   * Set true on PURE no-op runs (nothing in the work window, nothing touched)
   * to suppress the Cron Runs row (capacity audit 2026-07-28: cal-reminder-1h
   * "no bookings in window" rows were 31% of all log inflow). The wrapper
   * still writes ONE no-op heartbeat row per UTC day (Redis claimOnce) so the
   * daily-health-digest dead-man's switch keeps seeing the cron, and it
   * ALWAYS writes on error/partial/paused or recordsTouched > 0 — see
   * lib/cronRunPolicy.ts.
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
    let skipLogRequested = false;
    let skipReasonBreakdown: Record<string, number> | undefined;
    let returnedResponse: Response | null = null;
    let heartbeatRowId: string | null = null;
    if (opts?.heartbeat) {
      try {
        const started = await createRecord(TABLES.CRON_RUNS, {
          Name: name,
          'Started At': startedAt.toISOString(),
          Status: 'started',
          Notes: 'heartbeat — run in progress',
        });
        heartbeatRowId = (started as any)?.id || null;
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
      skipLogRequested = result.skipLog === true;
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
      // No-op row suppression (see CronRunResult.skipLog). Decision is pure
      // (lib/cronRunPolicy); the only I/O is the once-per-day Redis claim,
      // which fails OPEN (claim errors / Redis absent → write like before).
      let writeRow = true;
      try {
        if (skipLogRequested && status === 'success' && recordsTouched === 0 && !heartbeatRowId) {
          let dailyClaim: boolean | null = null;
          try {
            const { claimOnce } = await import('./rancherCapacity');
            dailyClaim = await claimOnce(
              `cronrun:noop-heartbeat:${name}:${new Date().toISOString().slice(0, 10)}`,
              26 * 60 * 60, // outlives the 25h dead-man window; date-keyed anyway
            );
          } catch {
            dailyClaim = null; // fail open
          }
          writeRow = shouldWriteCronRunRow({
            skipLogRequested,
            status,
            recordsTouched,
            heartbeatRowPending: !!heartbeatRowId,
            dailyHeartbeatClaimed: dailyClaim,
          });
          if (writeRow && dailyClaim === true) {
            notes = `${notes} · daily no-op heartbeat (other no-op rows suppressed)`.slice(0, 500);
          }
        }
      } catch {
        writeRow = true; // any surprise in the skip path → old behavior
      }
      if (!writeRow) {
        // Skip the Airtable write entirely; alerting below still runs
        // (a no-op success has nothing to alert anyway).
        console.info(`[withCronRun:${name}] no-op run — Cron Runs row suppressed (daily heartbeat already written)`);
      } else {
        try {
          const row: Record<string, unknown> = {
            Name: name,
            'Started At': startedAt.toISOString(),
            'Ended At': endedAt.toISOString(),
            'Duration ms': endedAt.getTime() - startedAt.getTime(),
            Status: status,
            'Records Touched': recordsTouched,
            Notes: notes,
          };
          if (skipReasonBreakdown && Object.keys(skipReasonBreakdown).length > 0) {
            row['Skip Reason Breakdown'] = JSON.stringify(skipReasonBreakdown);
          }
          if (heartbeatRowId) {
            // Complete the started-heartbeat row in place (don't write a second
            // row — a duplicate would double cron-run counts in the digest).
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
