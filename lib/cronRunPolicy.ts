// lib/cronRunPolicy.ts
//
// Pure decision: should withCronRun write a Cron Runs row for this run?
//
// Context (runtime audit 2026-07-28): cal-reminder-1h fires every 10 minutes
// and its "no bookings in window" runs were 31% of ALL Cron Runs inflow —
// 144 identical no-op rows/day against the Airtable 5 req/s ceiling and the
// log-retention drain. Handlers may now return `skipLog: true` on PURE no-op
// runs; the wrapper suppresses the row UNLESS:
//   - the run did real work, errored, was partial, or was paused (truth must
//     persist — a pause row is how the operator sees the pause worked);
//   - a 'started' heartbeat row is pending (it must be completed in place);
//   - this run won the once-per-day heartbeat claim (the daily-health-digest
//     dead-man's switch needs at least ONE row per 25h window), or the claim
//     couldn't be made (Redis unknown → fail OPEN, write like before).
//
// Kept separate from lib/cronRun.ts so it stays dependency-free + testable.

export interface CronRunRowDecisionInput {
  /** Handler returned `skipLog: true` (pure no-op run). */
  skipLogRequested: boolean;
  /** Final run status ('success' | 'partial' | 'error' | 'paused' | ...). */
  status: string;
  recordsTouched: number;
  /** A 'started' heartbeat row exists and must be completed in place. */
  heartbeatRowPending: boolean;
  /**
   * Result of the once-per-day Redis claim: true = this run writes today's
   * heartbeat row; false = another run already did; null = claim not
   * attempted / errored (fail open → write).
   */
  dailyHeartbeatClaimed: boolean | null;
}

export function shouldWriteCronRunRow(input: CronRunRowDecisionInput): boolean {
  if (!input.skipLogRequested) return true;
  if (input.status !== 'success') return true;
  if (input.recordsTouched > 0) return true;
  if (input.heartbeatRowPending) return true;
  // Pure no-op: write only the once-daily heartbeat. claimOnce fails open
  // (returns true when Redis is absent), so no-Redis environments keep the
  // old always-write behavior.
  return input.dailyHeartbeatClaimed !== false;
}
