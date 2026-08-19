// lib/logRetentionPlan.ts
//
// RETENTION WINDOWS + DRAIN BUDGET (capacity audit 2026-08-19).
//
// Airtable's Team-plan hard cap is 50,000 records PER BASE. When it is hit,
// Airtable rejects CREATE. lib/airtable.ts only retries unknown-field and
// bad-select-option errors, so a cap rejection propagates and
// app/api/consumers/route.ts returns a 500 "Could not complete signup." Every
// signup, referral, deposit and payment write fails at the same instant, it is
// buyer-visible, and ad spend keeps running into it. There is no partial
// failure mode — the base simply stops accepting rows.
//
// ── MEASURED, 2026-08-19 (live base, counts only) ───────────────────────────
//   TOTAL 36,451 / 50,000 (72.9%) — headroom 13,549
//   Email Sends   14,242  oldest 86d   inflow 399/day (7d) · 287/day (30d)
//   Cron Runs     11,521  oldest 31d   inflow 343/day (7d) · 372/day (30d)
//   Funnel Events  2,422  oldest 86d   inflow  21/day
//   Consumers      2,774  ·  Referrals 1,806  ·  Rancher Prospects 1,653
//   Stripe Events    723  ·  Gear Clicks 532  ·  Conversations 272
//   AI Audit Log     151  ·  Deal Events 131  ·  everything else <100
//   Gross inflow ~795 rows/day. Net (after the retention that IS working)
//   ~345/day ⇒ roughly 39 days of headroom.
//
// ── THE STRUCTURAL PROBLEM, which the drain rate alone does NOT solve ───────
// Steady state of a log table = window x inflow. At today's send rate:
//   Email Sends @ 90d  =  35,910 rows  (72% of the ENTIRE base cap, alone)
//   Cron Runs   @ 30d  =  10,290 rows
// That is 46,200 before a single buyer, rancher or payment row. The base is
// over its cap AT STEADY STATE even with retention working perfectly. Draining
// faster cannot fix that; only a shorter window or moving the table out of
// Airtable can. See the per-table notes below and the PR description.
//
// ── WHAT THIS FILE CHANGES ──────────────────────────────────────────────────
// The old drain was MAX_DELETES_PER_TABLE = 1,000 per table per run on a
// once-daily cron. Two consequences: (1) above ~1,000 rows/day on any single
// table the deficit compounds forever, and (2) there was no capacity to work
// down a BACKLOG — if a window is shortened, the resulting backlog drains at
// 1,000/day, so an ~18,000-row Email Sends backlog would take 18 days while
// the base sits against the cap. Replaced with a TIME-BUDGETED drain: each run
// spends up to RUN_BUDGET_MS deleting, shared fairly across tables, at a
// pacing that stays under half the Airtable request ceiling — and the cron
// runs 4x/day instead of once.
//
// Pure + import-clean so the arithmetic is unit-tested: logRetentionPlan.test.ts.

/** Airtable's documented per-base request ceiling. Exceeding it = 30s lockout. */
export const AIRTABLE_REQ_PER_SEC_CEILING = 5;

/** Airtable's batch-DELETE limit: 10 record ids per request. */
export const DELETE_BATCH_SIZE = 10;

/**
 * One 10-row DELETE every 400ms = 2.5 req/s, HALF the ceiling, so the cron
 * that exists to protect the base never becomes the thing that trips it. (The
 * previous 250ms = 4 req/s left only 1 req/s for live traffic.)
 */
export const DEFAULT_BATCH_PACING_MS = 400;

/** Of the route's maxDuration = 300s, leaving >=60s for reads, backup, response. */
export const RUN_BUDGET_MS = 240_000;

/** vercel.json: `10 3,9,15,21 * * *`. */
export const RUNS_PER_DAY = 4;

/**
 * Safety ceiling only. Time is what binds now — this exists so a
 * misconfiguration can't turn one run into an unbounded delete loop.
 */
export const MAX_DELETES_PER_TABLE_PER_RUN = 20_000;

/** No override may set a window below this. A typo must not be able to empty a table. */
export const MIN_RETENTION_DAYS = 7;

/** Measured gross inflow across all log tables, 7-day rate, 2026-08-19. */
export const MEASURED_DAILY_INFLOW_ROWS = 795;

/** UTC hour whose run also performs the once-daily backup + capacity census. */
export const BACKUP_RUN_UTC_HOUR = 9;

export interface RetentionRule {
  table: string;
  days: number;
  why: string;
  /**
   * True when the window is NOT ours to shorten — the table has audit,
   * compliance, or dedupe value and a change needs the operator's call.
   * Recommendations live in `why`; the number stays until Ben moves it (which
   * he can do without a deploy via LOG_RETENTION_DAYS_OVERRIDE).
   */
  operatorDecision?: boolean;
}

/**
 * The Email Sends retention window, exported so the ONE reader that depends on
 * the log reaching back a certain distance can check it instead of assuming.
 *
 * app/api/cron/send-scheduled dedupes a campaign against rows tagged with that
 * campaign. If the campaign started before this window, the dedupe set is
 * incomplete and re-sending would double-blast the recipients already emailed,
 * so that cron refuses to send rather than guess. Keep this in sync with the
 * 'Email Sends' entry in RETENTION below — the test pins that they match.
 */
export const EMAIL_SENDS_RETENTION_DAYS = 30;

export const RETENTION: readonly RetentionRule[] = [
  {
    table: 'Cron Runs',
    days: 30,
    why:
      'watchdog reads 24h, the monthly report reads 30d — 30d is the smallest window that keeps the ' +
      'monthly report honest. At 343 rows/day this is ~10,300 rows (20% of the base cap) at steady ' +
      'state: the second-largest consumer. RECOMMENDATION: keep 30d, and move this table off Airtable ' +
      'first if volume grows (it is a pure machine log with zero business value).',
  },
  {
    table: 'Email Sends',
    days: 30,
    why:
      'SHORTENED 90d -> 30d (2026-08-19) once the two lifetime-dedupe readers stopped depending on this ' +
      'log. At 399 sends/day, 90d converged to ~35,900 rows = 72% of the entire base cap on its own; 30d ' +
      'is ~12,000 rows (24%). The blocker was never the window, it was that two PERMANENT facts were ' +
      'derived by scanning an expiring log: testimonial-collection\'s "already asked" set (now ' +
      'Consumers[Testimonial Asked At]) and send-scheduled\'s per-campaign "already attempted" set (now ' +
      'bounded by the campaign start, and it refuses to send when that predates ' +
      'EMAIL_SENDS_RETENTION_DAYS rather than risk a double blast). Every other reader was already ' +
      'date-bounded at <=14d. Do not shorten below the campaign-resume horizon without revisiting ' +
      'send-scheduled: the constant above and this number must stay equal.',
  },
  {
    table: 'Funnel Events',
    days: 90,
    why:
      'the funnel uses the state-snapshot model, so these rows are supporting detail rather than the ' +
      'source of truth. At 21 rows/day a 90d window is only ~1,900 rows — it is not a capacity problem ' +
      'and there is nothing to gain by shortening it. Keep 90d.',
  },
  {
    table: 'Stripe Events',
    days: 60,
    operatorDecision: true,
    why:
      'MONEY dedup ledger. Stripe redelivers for <=3 days so 60d is already 20x the functional need, but ' +
      'these rows are the audit trail for "did we process this charge once", which is exactly what you ' +
      'want during a payment dispute. At ~17 rows/day it costs ~1,000 rows. RECOMMENDATION: leave at ' +
      '60d — the saving is negligible and the downside is a money question you cannot answer.',
  },
  {
    table: 'AI Audit Log',
    days: 90,
    operatorDecision: true,
    why:
      'append-only journal of actions an AI took on the business. Audit by definition, ~2 rows/day, ' +
      '~180 rows at 90d. RECOMMENDATION: leave at 90d — zero capacity benefit to touching it.',
  },
  {
    table: 'Gear Clicks',
    days: 90,
    why:
      'affiliate click log feeding attribution. Attribution reads recent windows, but affiliate ' +
      'commission questions can arrive late. At 17 rows/day 90d is ~1,500 rows. RECOMMENDATION: 60d is ' +
      'defensible and saves ~500 rows; not worth the churn today. Keep 90d.',
  },
  {
    table: 'Deal Events',
    days: 180,
    operatorDecision: true,
    why:
      'deal audit trail used for disputes. Stripe chargeback windows run to 120 days, so 180d is the ' +
      'correctly-chosen number, not an accident. At 5 rows/day it costs ~900 rows. RECOMMENDATION: ' +
      'leave at 180d.',
  },
];

// ── Drain arithmetic ─────────────────────────────────────────────────────

/** Sustained request rate implied by a pacing interval. */
export function requestsPerSecond(pacingMs: number): number {
  return pacingMs > 0 ? 1000 / pacingMs : Infinity;
}

/** The slowest pacing we will ever allow (i.e. the highest request rate). */
const MIN_SAFE_PACING_MS = Math.ceil(1000 / (AIRTABLE_REQ_PER_SEC_CEILING / 2));

/**
 * Pacing between DELETE batches. Env-tunable via LOG_RETENTION_PACING_MS so an
 * incident can be throttled without a deploy — but clamped so a reckless value
 * can never push the cron past half the Airtable ceiling. Longer is always
 * allowed (slower is always safe).
 */
export function resolveBatchPacingMs(): number {
  const raw = Number(process.env.LOG_RETENTION_PACING_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_BATCH_PACING_MS;
  return Math.max(raw, MIN_SAFE_PACING_MS);
}

/** How many rows a time budget can delete at this pacing and batch size. */
export function rowsAffordable(budgetMs: number, pacingMs: number, batchSize: number): number {
  if (budgetMs <= 0 || pacingMs <= 0 || batchSize <= 0) return 0;
  return Math.floor(budgetMs / pacingMs) * batchSize;
}

/**
 * Rows this configuration can delete across a whole day. `maxPerTablePerRun`
 * models the OLD hard cap (7 tables x cap x runs) so a test can contrast the
 * two shapes; omitted, the time budget is what binds.
 */
export function dailyDrainCapacityRows(opts: {
  runBudgetMs: number;
  pacingMs: number;
  batchSize: number;
  runsPerDay: number;
  maxPerTablePerRun?: number;
  tableCount?: number;
}): number {
  const { runBudgetMs, pacingMs, batchSize, runsPerDay, maxPerTablePerRun, tableCount = RETENTION.length } = opts;
  const byTime = rowsAffordable(runBudgetMs, pacingMs, batchSize) * runsPerDay;
  if (maxPerTablePerRun === undefined) return byTime;
  return Math.min(byTime, maxPerTablePerRun * tableCount * runsPerDay);
}

/**
 * Even split of the REMAINING run budget across the REMAINING tables. Because
 * it is recomputed per table, a table that drains early hands its leftover to
 * the ones behind it — while no single huge table can consume the whole run
 * and starve the rest.
 */
export function perTableBudgetMs(remainingMs: number, remainingTables: number): number {
  if (remainingMs <= 0 || remainingTables <= 0) return 0;
  return Math.floor(remainingMs / remainingTables);
}

// ── Operator overrides ───────────────────────────────────────────────────

/**
 * Parse LOG_RETENTION_DAYS_OVERRIDE, e.g. `Email Sends=45,Cron Runs=14`.
 * Exists so the operator can act on the recommendations above WITHOUT a
 * deploy, the moment he accepts the trade-off each one names.
 *
 * Refuses anything non-numeric, non-positive, or below MIN_RETENTION_DAYS — a
 * fat-fingered `Email Sends=0` must not be able to empty a table. Lengthening
 * is always accepted; it is always safe.
 */
export function parseRetentionOverrides(raw: string | undefined | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw) return out;
  for (const part of String(raw).split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const table = part.slice(0, eq).trim();
    const days = Number(part.slice(eq + 1).trim());
    if (!table) continue;
    if (!Number.isFinite(days) || days < MIN_RETENTION_DAYS) continue;
    out[table] = days;
  }
  return out;
}

/**
 * Apply overrides to the compiled-in rules. An override naming a table that is
 * NOT already under retention is IGNORED — retention must never be able to
 * start deleting from an entity table (Consumers, Referrals, Payments) because
 * of an env string.
 */
export function applyRetentionOverrides(
  rules: readonly RetentionRule[],
  overrides: Record<string, number>,
): RetentionRule[] {
  return rules.map((r) => (overrides[r.table] ? { ...r, days: overrides[r.table] } : { ...r }));
}

/**
 * True when this run should also do the once-daily legs (encrypted backup).
 * The cron fires 4x/day now; the backup keeps only the newest 14 blobs, so
 * running it every time would silently cut backup history from 14 days to 3.5.
 */
export function isCensusOrBackupRun(now: Date = new Date()): boolean {
  return now.getUTCHours() === BACKUP_RUN_UTC_HOUR;
}
