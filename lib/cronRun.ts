import { createRecord, TABLES } from './airtable';

type CronStatus = 'success' | 'partial' | 'error' | 'maintenance-blocked';

interface CronRunResult {
  status: CronStatus;
  recordsTouched?: number;
  notes?: string;
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
    let returnedResponse: Response | null = null;
    try {
      const result = await fn(request);
      status = result.status;
      recordsTouched = result.recordsTouched ?? 0;
      notes = result.notes ?? '';
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
        await createRecord(TABLES.CRON_RUNS, {
          Name: name,
          'Started At': startedAt.toISOString(),
          'Ended At': endedAt.toISOString(),
          'Duration ms': endedAt.getTime() - startedAt.getTime(),
          Status: status,
          'Records Touched': recordsTouched,
          Notes: notes,
        });
      } catch (logErr: any) {
        console.error(`[withCronRun:${name}] log write failed:`, logErr?.message);
      }
    }
    return returnedResponse!;
  };
}
