// lib/sendWindow.ts
//
// UPGRADE C — send-time gating for the combined email+SMS backfill campaign.
//
// RESEARCH (Attentive / Bloomreach / Omnisend 2025-26):
//   • EMAIL opens peak ~9-11am, with a strong mid-afternoon (~1-3pm) second
//     window. Sending into the open window lifts open→click materially.
//   • SMS best on WEEKDAYS, late morning (~9am-12pm) and especially early
//     evening 5-7pm local — 5-7pm has the best CTR (people are off work, phone
//     in hand). SMS sent overnight is both illegal-ish (TCPA quiet hours
//     8pm-8am local) and a deliverability/complaint risk.
//   • NEVER send overnight on either channel.
//
// The campaign cron runs hourly, so gating is naturally "send this hour only if
// it's a good local hour for this channel; otherwise DEFER to a later hourly run"
// (the buyer's wave stamp is untouched, so the next in-window run picks them up —
// nothing is dropped).
//
// LOCAL TIME APPROXIMATION: we map the buyer's US state → an IANA timezone and
// read the local hour/weekday in that zone via Intl.DateTimeFormat (zero deps,
// DST-correct). Unknown/blank/non-US state → DEFAULT_TZ (US Central) so a buyer
// is never dropped for lacking a clean state; central is the geographic mean of
// the US so the worst-case skew is ~2-3h.
//
// Pure + deterministic given (now, state, env-overridable windows). Unit-tested
// across hours, weekdays/weekends, and multiple timezones.

import { normalizeState } from './states';

export type Channel = 'email' | 'sms';

// Fallback zone for unknown/blank/non-US states — geographic middle of the US.
export const DEFAULT_TZ = 'America/Chicago';

// State (2-letter) → primary IANA timezone. For multi-zone states we pick the
// zone holding the bulk of the population (e.g. FL→Eastern, TX→Central) — an
// approximation by design (we only need to keep sends out of the overnight
// window, not pinpoint a county). Territories included for completeness.
export const STATE_TZ: Readonly<Record<string, string>> = {
  AL: 'America/Chicago',
  AK: 'America/Anchorage',
  AZ: 'America/Phoenix', // no DST
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DE: 'America/New_York',
  DC: 'America/New_York',
  FL: 'America/New_York', // panhandle is Central; bulk is Eastern
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu', // no DST
  ID: 'America/Boise', // north is Pacific; bulk is Mountain
  IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago',
  KS: 'America/Chicago', // far west is Mountain
  KY: 'America/New_York', // west is Central; bulk (Louisville/Lexington) Eastern
  LA: 'America/Chicago',
  ME: 'America/New_York',
  MD: 'America/New_York',
  MA: 'America/New_York',
  MI: 'America/New_York', // UP west is Central; bulk Eastern
  MN: 'America/Chicago',
  MS: 'America/Chicago',
  MO: 'America/Chicago',
  MT: 'America/Denver',
  NE: 'America/Chicago', // west is Mountain
  NV: 'America/Los_Angeles', // far NE is Mountain
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NY: 'America/New_York',
  NC: 'America/New_York',
  ND: 'America/Chicago', // SW is Mountain
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles', // far east is Mountain
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago', // west is Mountain
  TN: 'America/Chicago', // east (Knoxville/Chattanooga) Eastern; bulk Central
  TX: 'America/Chicago', // El Paso is Mountain
  UT: 'America/Denver',
  VT: 'America/New_York',
  VA: 'America/New_York',
  WA: 'America/Los_Angeles',
  WV: 'America/New_York',
  WI: 'America/Chicago',
  WY: 'America/Denver',
  // Territories
  PR: 'America/Puerto_Rico',
  VI: 'America/Puerto_Rico',
  GU: 'Pacific/Guam',
};

/** Resolve a buyer state (any spelling) → IANA tz, DEFAULT_TZ when unknown. */
export function tzForState(rawState: unknown): string {
  const code = normalizeState(rawState);
  if (code && STATE_TZ[code]) return STATE_TZ[code];
  return DEFAULT_TZ;
}

/**
 * The local hour (0-23) and ISO weekday (1=Mon..7=Sun) for `nowMs` in `tz`.
 * Uses Intl (DST-correct, zero deps). On a bad tz string, falls back to
 * DEFAULT_TZ rather than throwing.
 */
export function localHourAndDay(nowMs: number, tz: string): { hour: number; isoDay: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(new Date(nowMs));
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: DEFAULT_TZ,
      hour: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(new Date(nowMs));
  }
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
  // Intl can emit "24" for midnight under hour12:false — normalize to 0.
  let hour = parseInt(hourStr, 10);
  if (!Number.isFinite(hour) || hour === 24) hour = 0;
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const isoDay = map[wd] ?? 1;
  return { hour, isoDay };
}

export function isWeekend(isoDay: number): boolean {
  return isoDay === 6 || isoDay === 7;
}

// ── Window definitions (env-tunable) ──────────────────────────────────────────
//
// A window is a set of [startHour, endHour) ranges in LOCAL time, half-open so
// adjacent ranges don't double-count. Defaults encode the research.

export interface HourRange {
  start: number; // inclusive, 0-23
  end: number; // exclusive, 1-24
}

export interface WindowPolicy {
  ranges: HourRange[];
  /** When true, only Mon-Fri are eligible (weekends deferred). */
  weekdaysOnly: boolean;
}

// EMAIL: 9-11am + 1-4pm local, any day by default (email is fine on weekends;
// the research's day-of-week effect is far weaker for email than SMS). Overnight
// is excluded by construction.
const DEFAULT_EMAIL_RANGES: HourRange[] = [
  { start: 9, end: 11 },
  { start: 13, end: 16 },
];

// SMS: 9am-12pm + 5-7pm local, WEEKDAYS ONLY (TCPA quiet-hours + best-CTR
// research). 5-7pm is the prime window.
const DEFAULT_SMS_RANGES: HourRange[] = [
  { start: 9, end: 12 },
  { start: 17, end: 19 },
];

/**
 * Parse an env override like "9-11,13-16" into HourRange[]. Invalid / empty →
 * returns the provided fallback (so a typo'd env var can never NUKE a channel's
 * windows into "always defer" or "always send"). Clamps to [0,24].
 */
export function parseRanges(spec: string | undefined, fallback: HourRange[]): HourRange[] {
  if (!spec || !spec.trim()) return fallback;
  const out: HourRange[] = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (!m) continue;
    let start = parseInt(m[1], 10);
    let end = parseInt(m[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, Math.min(24, start));
    end = Math.max(0, Math.min(24, end));
    if (end <= start) continue; // ignore overnight/empty ranges (no wraparound)
    out.push({ start, end });
  }
  return out.length > 0 ? out : fallback;
}

/**
 * Resolve the live policy for a channel from env (read at call time so the cron
 * picks up changes without a redeploy of this module's defaults):
 *   CAMPAIGN_EMAIL_HOURS   e.g. "9-11,13-16"   (default)
 *   CAMPAIGN_SMS_HOURS     e.g. "9-12,17-19"   (default)
 *   CAMPAIGN_SMS_WEEKDAYS_ONLY  "false" to allow weekends (default true)
 *   CAMPAIGN_EMAIL_WEEKDAYS_ONLY "true" to restrict email to weekdays (default false)
 * `env` is injectable for tests.
 */
export function policyFor(channel: Channel, env: NodeJS.ProcessEnv = process.env): WindowPolicy {
  if (channel === 'email') {
    return {
      ranges: parseRanges(env.CAMPAIGN_EMAIL_HOURS, DEFAULT_EMAIL_RANGES),
      weekdaysOnly: env.CAMPAIGN_EMAIL_WEEKDAYS_ONLY === 'true', // default false
    };
  }
  return {
    ranges: parseRanges(env.CAMPAIGN_SMS_HOURS, DEFAULT_SMS_RANGES),
    weekdaysOnly: env.CAMPAIGN_SMS_WEEKDAYS_ONLY !== 'false', // default true
  };
}

/** True iff `hour` falls in any of the policy's half-open ranges. */
export function hourInRanges(hour: number, ranges: HourRange[]): boolean {
  return ranges.some((r) => hour >= r.start && hour < r.end);
}

/**
 * THE GATE — may we send on `channel` to a buyer in `state` at `nowMs`?
 *
 * true  → in a good local window for this channel → send now.
 * false → outside the window (incl. overnight / wrong weekday) → DEFER to a
 *         later hourly run (caller leaves the wave stamp untouched).
 *
 * Pure + deterministic. `env` injectable for tests.
 */
export function isWithinSendWindow(
  channel: Channel,
  rawState: unknown,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const tz = tzForState(rawState);
  const { hour, isoDay } = localHourAndDay(nowMs, tz);
  const policy = policyFor(channel, env);
  if (policy.weekdaysOnly && isWeekend(isoDay)) return false;
  return hourInRanges(hour, policy.ranges);
}

/** Convenience wrappers. */
export function isEmailWindow(rawState: unknown, nowMs: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return isWithinSendWindow('email', rawState, nowMs, env);
}
export function isSmsWindow(rawState: unknown, nowMs: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return isWithinSendWindow('sms', rawState, nowMs, env);
}
