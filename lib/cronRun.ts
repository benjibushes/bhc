import { createRecord, getAllRecords, TABLES, escapeAirtableValue } from './airtable';

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

// In-memory per-cron alert throttle. Survives the lifetime of a serverless
// function instance — fine for the use-case (we don't want to spam Telegram
// when a cron stays broken across multiple runs in the same warm container).
// Cross-instance throttle isn't required because a still-broken cron will
// re-alert on the first cold start, which is good signal.
const _alertLast: Map<string, number> = new Map();
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

async function maybeAlertTelegram(cron: string, status: CronStatus, notes: string): Promise<void> {
  if (status !== 'error' && status !== 'partial') return;
  const last = _alertLast.get(cron) || 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return;
  _alertLast.set(cron, Date.now());

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chat) return;

  const emoji = status === 'error' ? '🚨' : '🟡';
  const text = `${emoji} <b>CRON ${status.toUpperCase()}</b> · <code>${cron}</code>\n\n${notes.slice(0, 500)}`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
    });
  } catch (e: any) {
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
      await maybeAlertTelegram(name, status, notes);
    }
    return returnedResponse!;
  };
}
