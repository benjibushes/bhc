// lib/cronRunRollup.ts
//
// ONE Cron Runs row per cron per UTC day, instead of one per execution.
//
// THE DEFECT (capacity audit 2026-08-19). Cron Runs held 11,231 rows across
// 73 crons and 31 days — 22% of the base's entire 50,000-record cap, second
// only to Email Sends. It is a heartbeat log: `deploy-drift` alone wrote
// ~46.8 rows/day, `cal-reminder-1h` ~39.3, and a cluster of hourly crons
// ~23.4 each. Nothing reads a single execution. Every consumer — the
// /cronstatus card, /admin/health, /admin/today, the daily-health-digest
// dead-man's switch — collapses the table to most-recent-per-name before
// using it, which is exactly what a daily row already is.
//
// At 30-day retention this takes the table from ~11,231 rows to 73 x 30 =
// ~2,190, freeing ~18% of the cap permanently. It is bounded by CRON COUNT,
// not by how often crons fire, so raising a cron's frequency no longer costs
// database rows.
//
// WHAT THE ROLLUP MUST NOT BREAK
//
//  1. The dead-man's switch. lib/cronIntrospection::missingExpectedCrons
//     flags any EXPECTED_CRONS_24H entry whose latest `Started At` is absent
//     or older than 24h. `Started At` therefore tracks the LATEST run of the
//     day — never the first — or a cron that ran at 00:05 and again at 23:55
//     would read as 24h stale.
//
//  2. The Notes state-channel. THREE consumers read `Notes` off PRIOR runs as
//     durable state, scanning newest-first for the first parseable row:
//       - app/api/cron/campaign-autopilot  (its own prior run stats, 2d back)
//       - app/api/cron/learning-report     (its own ledger token, 15d back)
//       - app/api/cron/learning-report     (campaign-autopilot's eligible
//                                           pool, 7d back)
//     A naive "latest wins" merge would let a later no-op run with empty
//     Notes ERASE the run that carried the token, and those readers would
//     silently fall back to a stale row or 'none'. So Notes only advances
//     when the incoming run actually has notes — see mergeCronRunRollup.
//     (All four state-channel crons currently write <=1 row/day, so nothing
//     is collapsed for them today. The guard is structural, not incidental:
//     it must keep holding if their frequency ever rises.)
//
//  3. Per-day run counts. The Telegram day-report counted ROWS per cron.
//     With one row per day that count is always 1, so the row carries an
//     explicit `Run Count`, and `Errors` accumulates the day's failures so a
//     day that failed three times then succeeded is not silently green.
//
// Pure on purpose: no I/O, no Date.now(). lib/cronRun.ts owns the Airtable
// read/write and falls back to a plain append if anything here or in the
// upsert throws, so the worst case is the old behaviour.

/** The Airtable fields a rollup row carries. Names are load-bearing. */
export interface CronRunRollupRow {
  'Name'?: unknown;
  'Run Day'?: unknown;
  'Started At'?: unknown;
  'Ended At'?: unknown;
  'Duration ms'?: unknown;
  'Status'?: unknown;
  'Records Touched'?: unknown;
  'Run Count'?: unknown;
  'Errors'?: unknown;
  'Notes'?: unknown;
  'Skip Reason Breakdown'?: unknown;
}

/** One execution's outcome, as withCronRun observed it. */
export interface CronRunObservation {
  name: string;
  startedAtISO: string;
  endedAtISO: string;
  durationMs: number;
  status: string;
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}

/**
 * The UTC calendar day a run belongs to, as `YYYY-MM-DD`.
 *
 * UTC deliberately, not local: Vercel crons are scheduled in UTC and the
 * dead-man window is a UTC 24h. A local-time key would rotate the row
 * mid-schedule for anyone west of Greenwich and split a day in two.
 *
 * Returns '' for an unparseable stamp so the caller can fall back to a plain
 * append rather than write a row keyed on garbage.
 */
export function rollupDayKey(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/** Statuses that mean the run did not cleanly succeed. */
const FAILED_STATUSES: ReadonlySet<string> = new Set(['error', 'partial']);

const toNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v == null ? '' : String(v));

/**
 * Merge one execution into the day's row and return the FULL field set to
 * write. `existing` is null for the first run of the day.
 *
 * Field semantics, each chosen against a real consumer:
 *   Started At       LATEST run's start   — the dead-man reads freshness here
 *   Ended At         LATEST run's end
 *   Duration ms      LATEST run's duration — "how long did it just take"
 *   Status           LATEST run's status   — matches every existing reader,
 *                                            which already shows last-status
 *   Records Touched  SUM over the day      — "what did this cron do today";
 *                                            a per-run value on a per-day row
 *                                            would under-report the day's work
 *   Run Count        +1
 *   Errors           += 1 when the run failed or was partial
 *   Notes            LATEST run that HAS notes (see header, point 2)
 *   Skip Reason      LATEST run that HAS one, same reasoning as Notes
 *
 * Out-of-order arrival is handled: a late-landing older run still increments
 * the counters but must NOT drag `Started At` backwards, or the dead-man
 * would see a stale timestamp for a cron that is in fact running.
 */
export function mergeCronRunRollup(
  existing: CronRunRollupRow | null,
  obs: CronRunObservation,
): Record<string, unknown> {
  const dayKey = rollupDayKey(obs.startedAtISO);
  const failed = FAILED_STATUSES.has(obs.status);

  if (!existing) {
    const row: Record<string, unknown> = {
      'Name': obs.name,
      'Run Day': dayKey,
      'Started At': obs.startedAtISO,
      'Ended At': obs.endedAtISO,
      'Duration ms': obs.durationMs,
      'Status': obs.status,
      'Records Touched': obs.recordsTouched,
      'Run Count': 1,
      'Errors': failed ? 1 : 0,
      'Notes': obs.notes,
    };
    if (obs.skipReasonBreakdown && Object.keys(obs.skipReasonBreakdown).length > 0) {
      row['Skip Reason Breakdown'] = JSON.stringify(obs.skipReasonBreakdown);
    }
    return row;
  }

  const prevStartedMs = new Date(str(existing['Started At'])).getTime();
  const thisStartedMs = new Date(obs.startedAtISO).getTime();
  // A run that started EARLIER than what the row already has is a late
  // arrival — count it, but never move the freshness stamps backwards.
  const isNewest =
    !Number.isFinite(prevStartedMs) ||
    (Number.isFinite(thisStartedMs) && thisStartedMs >= prevStartedMs);

  const row: Record<string, unknown> = {
    'Name': obs.name,
    'Run Day': dayKey,
    'Started At': isNewest ? obs.startedAtISO : str(existing['Started At']),
    'Ended At': isNewest ? obs.endedAtISO : str(existing['Ended At']),
    'Duration ms': isNewest ? obs.durationMs : toNum(existing['Duration ms']),
    'Status': isNewest ? obs.status : str(existing['Status']),
    'Records Touched': toNum(existing['Records Touched']) + obs.recordsTouched,
    'Run Count': toNum(existing['Run Count']) + 1,
    'Errors': toNum(existing['Errors']) + (failed ? 1 : 0),
    // Notes advance only on a run that HAS notes, and only when that run is
    // the newest — otherwise a late no-op erases the state channel.
    'Notes': isNewest && obs.notes ? obs.notes : str(existing['Notes']),
  };

  const incomingSkip =
    obs.skipReasonBreakdown && Object.keys(obs.skipReasonBreakdown).length > 0
      ? JSON.stringify(obs.skipReasonBreakdown)
      : '';
  const carried = str(existing['Skip Reason Breakdown']);
  if (isNewest && incomingSkip) row['Skip Reason Breakdown'] = incomingSkip;
  else if (carried) row['Skip Reason Breakdown'] = carried;

  return row;
}

/**
 * The heartbeat pre-write (opts.heartbeat crons). Marks the day's row as
 * in-progress WITHOUT disturbing the day's accumulated counters, so a
 * maxDuration kill still leaves a row stuck at 'started' for
 * daily-health-digest to flag — the whole point of heartbeat mode — while
 * the earlier runs' work totals survive.
 *
 * Returns only the fields to patch, never a full row.
 */
export function heartbeatPatch(startedAtISO: string): Record<string, unknown> {
  return {
    'Run Day': rollupDayKey(startedAtISO),
    'Started At': startedAtISO,
    'Status': 'started',
  };
}
