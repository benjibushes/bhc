import { createRecord, TABLES } from './airtable';

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
): (request: Request) => Promise<Response> {
  return async function wrapped(request: Request): Promise<Response> {
    const startedAt = new Date();
    let endedAt: Date = startedAt;
    let status: CronStatus = 'error';
    let recordsTouched = 0;
    let notes = '';
    let skipReasonBreakdown: Record<string, number> | undefined;
    let returnedResponse: Response | null = null;
    try {
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
        await createRecord(TABLES.CRON_RUNS, row);
      } catch (logErr: any) {
        console.error(`[withCronRun:${name}] log write failed:`, logErr?.message);
      }
    }
    return returnedResponse!;
  };
}
