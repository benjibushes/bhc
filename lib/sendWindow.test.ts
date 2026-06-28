import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tzForState,
  localHourAndDay,
  isWeekend,
  parseRanges,
  policyFor,
  hourInRanges,
  isWithinSendWindow,
  isEmailWindow,
  isSmsWindow,
  DEFAULT_TZ,
} from './sendWindow';

// Helper: build a UTC instant for a given date + UTC hour.
const utc = (y: number, mo: number, d: number, h: number, mi = 0) =>
  Date.UTC(y, mo - 1, d, h, mi, 0);

// 2026-06-27 is a SATURDAY and is during US DST:
//   EDT = UTC-4, CDT = UTC-5, MDT = UTC-6, PDT = UTC-7, MST(AZ)=UTC-7, HST=UTC-10.
// 2026-06-29 is a MONDAY (weekday).

// ─── state → timezone ────────────────────────────────────────────────────────

test('tzForState maps representative states to the right zones', () => {
  assert.equal(tzForState('CA'), 'America/Los_Angeles');
  assert.equal(tzForState('NY'), 'America/New_York');
  assert.equal(tzForState('TX'), 'America/Chicago');
  assert.equal(tzForState('CO'), 'America/Denver');
  assert.equal(tzForState('AZ'), 'America/Phoenix'); // no DST
  assert.equal(tzForState('HI'), 'Pacific/Honolulu');
  assert.equal(tzForState('Florida'), 'America/New_York'); // full name normalizes
});

test('tzForState falls back to DEFAULT_TZ (central) for unknown/blank/non-US', () => {
  assert.equal(tzForState(''), DEFAULT_TZ);
  assert.equal(tzForState(undefined), DEFAULT_TZ);
  assert.equal(tzForState('Ontario'), DEFAULT_TZ);
  assert.equal(tzForState('ZZ'), DEFAULT_TZ);
});

// ─── local hour/day derivation (DST-correct via Intl) ────────────────────────

test('localHourAndDay: 14:00 UTC on a Monday is 10am EDT (NY), weekday', () => {
  const { hour, isoDay } = localHourAndDay(utc(2026, 6, 29, 14), 'America/New_York');
  assert.equal(hour, 10);
  assert.equal(isoDay, 1); // Monday
});

test('localHourAndDay: 14:00 UTC is 7am PDT (LA)', () => {
  const { hour } = localHourAndDay(utc(2026, 6, 29, 14), 'America/Los_Angeles');
  assert.equal(hour, 7);
});

test('localHourAndDay: midnight rollover handled (02:00 UTC Mon = 10pm Sun EDT)', () => {
  const { hour, isoDay } = localHourAndDay(utc(2026, 6, 29, 2), 'America/New_York');
  assert.equal(hour, 22); // 02:00 UTC − 4h (EDT) = 22:00 previous day
  assert.equal(isoDay, 7); // still Sunday locally
});

test('localHourAndDay: bad tz string falls back without throwing', () => {
  const { hour } = localHourAndDay(utc(2026, 6, 29, 17), 'Not/AZone');
  // Falls back to DEFAULT_TZ (Chicago, CDT -5) → 12.
  assert.equal(hour, 12);
});

test('isWeekend: Sat/Sun true, Mon-Fri false', () => {
  assert.equal(isWeekend(6), true);
  assert.equal(isWeekend(7), true);
  for (const d of [1, 2, 3, 4, 5]) assert.equal(isWeekend(d), false);
});

// ─── range parsing (env override safety) ─────────────────────────────────────

test('parseRanges: valid spec parses', () => {
  assert.deepEqual(parseRanges('9-11,13-16', []), [
    { start: 9, end: 11 },
    { start: 13, end: 16 },
  ]);
});

test('parseRanges: blank/invalid → fallback (never nukes a channel)', () => {
  const fb = [{ start: 9, end: 12 }];
  assert.deepEqual(parseRanges('', fb), fb);
  assert.deepEqual(parseRanges(undefined, fb), fb);
  assert.deepEqual(parseRanges('garbage', fb), fb);
  assert.deepEqual(parseRanges('25-99', fb), fb, 'end>start but both clamp; 99→24,25→24 → empty → fallback');
});

test('parseRanges: drops overnight/empty ranges (no wraparound)', () => {
  // 20-6 would be overnight — dropped; only 9-11 survives.
  assert.deepEqual(parseRanges('20-6,9-11', [{ start: 0, end: 1 }]), [{ start: 9, end: 11 }]);
});

test('parseRanges: clamps hours into [0,24]', () => {
  assert.deepEqual(parseRanges('-3-30', [{ start: 1, end: 2 }]), [{ start: 1, end: 2 }]);
  assert.deepEqual(parseRanges('8-26', []), [{ start: 8, end: 24 }]);
});

test('hourInRanges: half-open [start,end)', () => {
  const r = [{ start: 9, end: 11 }];
  assert.equal(hourInRanges(9, r), true);
  assert.equal(hourInRanges(10, r), true);
  assert.equal(hourInRanges(11, r), false, 'end exclusive');
  assert.equal(hourInRanges(8, r), false);
});

// ─── policy resolution from env ──────────────────────────────────────────────

test('policyFor: email defaults — 9-11 + 13-16, weekends allowed', () => {
  const p = policyFor('email', {} as NodeJS.ProcessEnv);
  assert.deepEqual(p.ranges, [{ start: 9, end: 11 }, { start: 13, end: 16 }]);
  assert.equal(p.weekdaysOnly, false);
});

test('policyFor: sms defaults — 9-12 + 17-19, weekdays only', () => {
  const p = policyFor('sms', {} as NodeJS.ProcessEnv);
  assert.deepEqual(p.ranges, [{ start: 9, end: 12 }, { start: 17, end: 19 }]);
  assert.equal(p.weekdaysOnly, true);
});

test('policyFor: env overrides windows + weekday flags', () => {
  const env = {
    CAMPAIGN_EMAIL_HOURS: '8-9',
    CAMPAIGN_EMAIL_WEEKDAYS_ONLY: 'true',
    CAMPAIGN_SMS_HOURS: '18-20',
    CAMPAIGN_SMS_WEEKDAYS_ONLY: 'false',
  } as unknown as NodeJS.ProcessEnv;
  const e = policyFor('email', env);
  assert.deepEqual(e.ranges, [{ start: 8, end: 9 }]);
  assert.equal(e.weekdaysOnly, true);
  const s = policyFor('sms', env);
  assert.deepEqual(s.ranges, [{ start: 18, end: 20 }]);
  assert.equal(s.weekdaysOnly, false);
});

// ─── THE GATE — across hours / days / timezones ──────────────────────────────

const ENV = {} as NodeJS.ProcessEnv; // use defaults

test('EMAIL window: 10am local (in 9-11) → send; in each timezone', () => {
  // 10am local for each zone (Monday), defaults.
  assert.equal(isEmailWindow('NY', utc(2026, 6, 29, 14), ENV), true); // 10 EDT
  assert.equal(isEmailWindow('TX', utc(2026, 6, 29, 15), ENV), true); // 10 CDT
  assert.equal(isEmailWindow('CO', utc(2026, 6, 29, 16), ENV), true); // 10 MDT
  assert.equal(isEmailWindow('CA', utc(2026, 6, 29, 17), ENV), true); // 10 PDT
});

test('EMAIL window: mid-afternoon (2pm, in 13-16) → send', () => {
  assert.equal(isEmailWindow('NY', utc(2026, 6, 29, 18), ENV), true); // 14 EDT
});

test('EMAIL window: 8am local (before 9) → defer', () => {
  assert.equal(isEmailWindow('NY', utc(2026, 6, 29, 12), ENV), false); // 8 EDT
});

test('EMAIL window: noon local (the 11-13 gap) → defer', () => {
  assert.equal(isEmailWindow('NY', utc(2026, 6, 29, 16), ENV), false); // 12 EDT
});

test('EMAIL window: overnight (3am local) → defer', () => {
  assert.equal(isEmailWindow('NY', utc(2026, 6, 29, 7), ENV), false); // 3 EDT
});

test('EMAIL window: weekend allowed by default (Saturday 10am EDT) → send', () => {
  assert.equal(isEmailWindow('NY', utc(2026, 6, 27, 14), ENV), true); // Sat 10 EDT
});

test('SMS window: 10am local weekday (in 9-12) → send', () => {
  assert.equal(isSmsWindow('NY', utc(2026, 6, 29, 14), ENV), true); // Mon 10 EDT
});

test('SMS window: 6pm local weekday (in 17-19, best CTR) → send', () => {
  assert.equal(isSmsWindow('CA', utc(2026, 6, 30, 1), ENV), true); // Mon 18 PDT (2026-06-29 18:00 PDT = 2026-06-30 01:00 UTC)
});

test('SMS window: 2pm local (the 12-17 gap) → defer', () => {
  assert.equal(isSmsWindow('NY', utc(2026, 6, 29, 18), ENV), false); // 14 EDT
});

test('SMS window: overnight (9pm local, after 19) → defer', () => {
  assert.equal(isSmsWindow('NY', utc(2026, 6, 30, 1), ENV), false); // 21 EDT
});

test('SMS window: WEEKEND deferred even in a good hour (Saturday 10am EDT)', () => {
  assert.equal(isSmsWindow('NY', utc(2026, 6, 27, 14), ENV), false); // Sat 10 EDT → weekday-only blocks
});

test('AZ has no DST — 10am MST is 17:00 UTC in summer (in window)', () => {
  assert.equal(isEmailWindow('AZ', utc(2026, 6, 29, 17), ENV), true); // 10 MST
  assert.equal(isEmailWindow('AZ', utc(2026, 6, 29, 15), ENV), false); // 8 MST → before 9 → defer
});

test('unknown state uses central fallback for the window', () => {
  // 10am CDT (central fallback) = 15:00 UTC.
  assert.equal(isEmailWindow('ZZ', utc(2026, 6, 29, 15), ENV), true);
  assert.equal(isEmailWindow('', utc(2026, 6, 29, 13), ENV), false); // 8 CDT → defer
});

test('isWithinSendWindow is the shared core for both channels', () => {
  assert.equal(isWithinSendWindow('email', 'NY', utc(2026, 6, 29, 14), ENV), true);
  assert.equal(isWithinSendWindow('sms', 'NY', utc(2026, 6, 29, 14), ENV), true);
});
