// lib/baseCapacity.ts
//
// AIRTABLE BASE-CAPACITY ALARM (capacity audit 2026-08-19).
//
// Before this file, NOTHING watched the one number that can take the whole
// product down at once. Measured on 2026-08-19 the base was at 36,451 / 50,000
// records — 72.9% full, roughly 39 days of headroom at net inflow — and there
// was no cron, no dashboard tile and no alert anywhere that would have
// mentioned it. The first symptom would have been the outage itself.
//
// WHAT THE WALL LOOKS LIKE: at 50,000 records Airtable rejects CREATE.
// lib/airtable.ts only retries unknown-field and bad-select-option errors, so
// the rejection propagates and app/api/consumers/route.ts returns a 500
// "Could not complete signup." Signups, referrals, deposits and payment writes
// all fail simultaneously, it is buyer-visible, and ad spend keeps running into
// a broken funnel. There is no graceful degradation and no partial mode.
//
// WHY TWO AXES: percentage alone is not enough. A base at 50% that is filling
// at 3,000 rows/day is eight days from the wall, and a percentage-only alarm
// would call that healthy. So every classification takes the WORSE of
// "how full" and "how many days of runway", and the runway is computed from
// inflow the census MEASURES (rows created in the last 24h) rather than from a
// number somebody typed once.
//
// Pure + import-clean so the thresholds are unit-tested: baseCapacity.test.ts.
// The cron that feeds it is app/api/cron/base-capacity/route.ts.

/** Airtable Team-plan per-base record cap. */
export const AIRTABLE_RECORD_CAP = 50_000;

// ── Thresholds ───────────────────────────────────────────────────────────
// Chosen so that the state the base was ACTUALLY in when this was written
// (72.9%, ~39 days) produces a real, daily, non-ignorable warning — and so
// that the levels above it escalate to the loud rail with enough runway to do
// something about it (shortening a retention window and draining the backlog
// takes hours, not weeks; a plan upgrade or a move off Airtable takes days).

/** Observed and logged, in the daily digest. Not paged — this must not become noise. */
export const WATCH_PCT = 60;
/** Daily 'normal' operator card. Something must be scheduled. */
export const WARN_PCT = 70;
/** Loud. Runway is now short enough that a slow fix will not land in time. */
export const CRITICAL_PCT = 85;
/** Loud, worded as an outage-in-progress. Writes are about to start failing. */
export const EMERGENCY_PCT = 95;

/** Days-to-cap bands. Time can escalate a level on its own. */
export const WATCH_DAYS = 90;
export const WARN_DAYS = 45;
export const CRITICAL_DAYS = 21;

export type CapacityLevel = 'ok' | 'watch' | 'warn' | 'critical' | 'emergency';

const LEVEL_ORDER: CapacityLevel[] = ['ok', 'watch', 'warn', 'critical', 'emergency'];
function worst(a: CapacityLevel, b: CapacityLevel): CapacityLevel {
  return LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b;
}

/**
 * The cap in force. Env-tunable via AIRTABLE_RECORD_CAP so a plan upgrade is a
 * one-line change rather than a deploy. Garbage / non-positive falls back to
 * the Team-plan 50k (a zero cap would make every base look 100% full).
 */
export function resolveRecordCap(): number {
  const raw = Number(process.env.AIRTABLE_RECORD_CAP);
  return Number.isFinite(raw) && raw > 0 ? raw : AIRTABLE_RECORD_CAP;
}

export interface CapacityClassification {
  level: CapacityLevel;
  pct: number;
  headroom: number;
  total: number;
  cap: number;
}

export function classifyCapacity(total: number, cap: number = resolveRecordCap()): CapacityClassification {
  const pct = Number(((total / cap) * 100).toFixed(1));
  const headroom = Math.max(0, cap - total);
  let level: CapacityLevel = 'ok';
  if (pct >= EMERGENCY_PCT) level = 'emergency';
  else if (pct >= CRITICAL_PCT) level = 'critical';
  else if (pct >= WARN_PCT) level = 'warn';
  else if (pct >= WATCH_PCT) level = 'watch';
  return { level, pct, headroom, total, cap };
}

/**
 * Days until the base hits the cap at `inflowPerDay` NET rows/day. Returns
 * null when the base is flat or shrinking (retention out-pacing inflow — there
 * is no cap date). Rounds DOWN so the projection is never optimistic.
 */
export function projectDaysToCap(opts: {
  total: number;
  inflowPerDay: number;
  cap?: number;
}): number | null {
  const cap = opts.cap ?? resolveRecordCap();
  if (!Number.isFinite(opts.inflowPerDay) || opts.inflowPerDay <= 0) return null;
  const headroom = cap - opts.total;
  if (headroom <= 0) return 0;
  return Math.floor(headroom / opts.inflowPerDay);
}

export interface CapacityAlarm extends CapacityClassification {
  /** True when the operator should actually be pinged. */
  fire: boolean;
  urgency: 'normal' | 'loud';
  summary: string;
  daysToCap: number | null;
  inflowPerDay: number;
  biggestTables: Array<{ table: string; count: number }>;
  dedupeKey: string;
}

function n(x: number): string {
  return x.toLocaleString('en-US');
}

export function capacityAlarm(opts: {
  total: number;
  inflowPerDay: number;
  cap?: number;
  biggestTables?: Array<{ table: string; count: number }>;
  now?: Date;
}): CapacityAlarm {
  const cap = opts.cap ?? resolveRecordCap();
  const byPct = classifyCapacity(opts.total, cap);
  const daysToCap = projectDaysToCap({ total: opts.total, inflowPerDay: opts.inflowPerDay, cap });

  let byTime: CapacityLevel = 'ok';
  if (daysToCap !== null) {
    if (daysToCap <= CRITICAL_DAYS) byTime = 'critical';
    else if (daysToCap <= WARN_DAYS) byTime = 'warn';
    else if (daysToCap <= WATCH_DAYS) byTime = 'watch';
  }

  const level = worst(byPct.level, byTime);
  const runway = daysToCap === null ? 'not growing' : `~${daysToCap} days to the cap`;
  const summary =
    level === 'emergency'
      ? `Airtable base ${byPct.pct}% FULL — writes about to fail (${n(opts.total)}/${n(cap)}, ${runway})`
      : `Airtable base ${byPct.pct}% full — ${n(opts.total)}/${n(cap)}, ${runway}`;

  const day = (opts.now ?? new Date()).toISOString().slice(0, 10);

  return {
    ...byPct,
    level,
    fire: level === 'warn' || level === 'critical' || level === 'emergency',
    urgency: level === 'warn' ? 'normal' : 'loud',
    summary,
    daysToCap,
    inflowPerDay: opts.inflowPerDay,
    biggestTables: opts.biggestTables ?? [],
    // Per-level per-day: a stable state pings once a day, an ESCALATION always
    // gets through because the level is part of the key.
    dedupeKey: `base-capacity:${level}:${day}`,
  };
}

/**
 * The operator-facing body. Always carries the numbers needed to act — how
 * full, how much room, how fast it is filling, and WHICH tables to cut — plus,
 * at warn and above, a plain statement of what breaks at the wall.
 */
export function formatCapacityDetail(alarm: CapacityAlarm): string {
  const lines: string[] = [];
  lines.push(`${n(alarm.total)} / ${n(alarm.cap)} records (${alarm.pct}%) — headroom ${n(alarm.headroom)}`);
  lines.push(
    alarm.daysToCap === null
      ? `Net inflow ${n(alarm.inflowPerDay)}/day — no measurable growth, retention is keeping up`
      : `Net inflow ${n(alarm.inflowPerDay)}/day — ~${alarm.daysToCap} days to the cap`,
  );
  if (alarm.biggestTables.length) {
    lines.push(
      'Biggest: ' + alarm.biggestTables.map((t) => `${t.table} ${n(t.count)}`).join(' · '),
    );
  }
  if (alarm.fire) {
    lines.push(
      'At the cap Airtable REJECTS every CREATE: signup, referral, deposit and payment writes all ' +
        'fail at once, buyer-visible, while ad spend keeps running.',
    );
    lines.push(
      'Fastest levers: shorten a retention window via LOG_RETENTION_DAYS_OVERRIDE (the drain can ' +
        'clear the backlog same-day), then move the highest-volume log table off Airtable.',
    );
  }
  return lines.join('\n');
}
