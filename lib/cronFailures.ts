// lib/cronFailures.ts
//
// ONE definition of "a cron run failed in the last 24h", shared by:
//   - app/api/cron/daily-health-digest (the 9am Telegram)
//   - app/api/admin/today             (the cockpit's WHAT-BROKE band)
//
// Extracted verbatim from the digest (2026-08-01, Wave 1B) so the screen and
// the Telegram can never disagree about whether the platform is red.
//
// Two failure classes:
//   • error/partial rows — the handler itself reported a problem.
//   • stale 'started' rows — the heartbeat row was written but never completed
//     within 2h, meaning the lambda was KILLED (maxDuration) before `finally`
//     ran. Previously invisible because the next hourly tick writes a fresh
//     row (scale audit 2026-07-22).
//
// PURE: no I/O, no Date.now() — the caller passes `nowMs`.

/** A row is "stale started" after this long without completing. */
export const STALE_STARTED_MS = 2 * 60 * 60 * 1000;

export interface CronRunRowLike {
  Status?: unknown;
  'Started At'?: unknown;
  Name?: unknown;
}

export interface CronFailureSummary {
  /** Every failing run row (error + partial + stale-started). */
  errorRuns: CronRunRowLike[];
  /** Distinct cron names among the failing runs. */
  failedCronNames: string[];
}

export function classifyCronFailures(
  cronRuns: CronRunRowLike[],
  nowMs: number,
): CronFailureSummary {
  const staleStartedRuns = (cronRuns || []).filter((r) => {
    if (String(r['Status'] || '').toLowerCase() !== 'started') return false;
    const startedAt = new Date(String(r['Started At'] || '')).getTime();
    return Number.isFinite(startedAt) && nowMs - startedAt > STALE_STARTED_MS;
  });
  const errorRuns = (cronRuns || [])
    .filter((r) => {
      const s = String(r['Status'] || '').toLowerCase();
      return s === 'error' || s === 'partial';
    })
    .concat(staleStartedRuns);
  const failedCronNames = Array.from(
    new Set(errorRuns.map((r) => String(r['Name'] || 'unknown'))),
  );
  return { errorRuns, failedCronNames };
}
