// Base-capacity alarm (capacity audit 2026-08-19).
//
// WHAT BROKE: nothing watched this at all. The base was at 36,451 / 50,000
// records — 72.9%, roughly 39 days of headroom at measured net inflow — and no
// cron, dashboard or alert would have said a word until CREATE started
// throwing and every signup, referral, deposit and payment write failed at
// once, buyer-visible, with ad spend running.
//
// These tests pin the thresholds and, most importantly, that the alarm FIRES
// at the state the base was actually in on the day it was written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIRTABLE_RECORD_CAP,
  WATCH_PCT,
  WARN_PCT,
  CRITICAL_PCT,
  EMERGENCY_PCT,
  WATCH_DAYS,
  WARN_DAYS,
  CRITICAL_DAYS,
  classifyCapacity,
  projectDaysToCap,
  capacityAlarm,
  resolveRecordCap,
  formatCapacityDetail,
} from './baseCapacity';

// ── The measurement that motivated this file ─────────────────────────────

const MEASURED_TOTAL = 36_451; // live base, 2026-08-19
const MEASURED_NET_INFLOW = 345; // rows/day net of retention

test('FIRES TODAY: the real 2026-08-19 base state produces a real alert, not a shrug', () => {
  const alarm = capacityAlarm({ total: MEASURED_TOTAL, inflowPerDay: MEASURED_NET_INFLOW });
  assert.equal(alarm.fire, true, '72.9% with ~39 days of headroom must not be silent');
  assert.equal(alarm.level, 'warn');
  assert.equal(alarm.urgency, 'normal');
  assert.match(alarm.summary, /72\.9%/);
  assert.match(alarm.summary, /39 days|3[0-9] days/);
});

test('the pre-audit state (nothing watching) is exactly what this prevents: silence at 72.9%', () => {
  // Guard against someone "tuning down the noise" until the alarm is useless.
  assert.ok(WARN_PCT <= 72, `WARN_PCT ${WARN_PCT} would let the measured 72.9% state pass silently`);
});

// ── classifyCapacity ─────────────────────────────────────────────────────

test('percentage bands', () => {
  assert.equal(classifyCapacity(0).level, 'ok');
  assert.equal(classifyCapacity(AIRTABLE_RECORD_CAP * 0.5).level, 'ok');
  assert.equal(classifyCapacity(AIRTABLE_RECORD_CAP * (WATCH_PCT / 100)).level, 'watch');
  assert.equal(classifyCapacity(AIRTABLE_RECORD_CAP * (WARN_PCT / 100)).level, 'warn');
  assert.equal(classifyCapacity(AIRTABLE_RECORD_CAP * (CRITICAL_PCT / 100)).level, 'critical');
  assert.equal(classifyCapacity(AIRTABLE_RECORD_CAP * (EMERGENCY_PCT / 100)).level, 'emergency');
  assert.equal(classifyCapacity(AIRTABLE_RECORD_CAP).level, 'emergency');
});

test('headroom and percentage are reported, not just a level', () => {
  const c = classifyCapacity(36_451);
  assert.equal(c.headroom, 50_000 - 36_451);
  assert.equal(c.pct, Number(((36_451 / 50_000) * 100).toFixed(1)));
});

test('bands are ordered and leave no gap (every total lands in exactly one level)', () => {
  assert.ok(WATCH_PCT < WARN_PCT && WARN_PCT < CRITICAL_PCT && CRITICAL_PCT < EMERGENCY_PCT);
  let prev = -1;
  const order = ['ok', 'watch', 'warn', 'critical', 'emergency'];
  for (let total = 0; total <= AIRTABLE_RECORD_CAP; total += 250) {
    const idx = order.indexOf(classifyCapacity(total).level);
    assert.ok(idx >= prev, `level went BACKWARDS at ${total} rows`);
    prev = idx;
  }
});

// ── projectDaysToCap ─────────────────────────────────────────────────────

test('projection uses net inflow and rounds down (never optimistic)', () => {
  assert.equal(projectDaysToCap({ total: 36_451, inflowPerDay: 345 }), Math.floor(13_549 / 345));
  assert.equal(projectDaysToCap({ total: 49_999, inflowPerDay: 345 }), 0);
});

test('a base that is SHRINKING (retention out-pacing inflow) has no cap date', () => {
  assert.equal(projectDaysToCap({ total: 36_451, inflowPerDay: 0 }), null);
  assert.equal(projectDaysToCap({ total: 36_451, inflowPerDay: -50 }), null);
});

test('already at or over the cap projects zero days, not a negative', () => {
  assert.equal(projectDaysToCap({ total: 50_000, inflowPerDay: 10 }), 0);
  assert.equal(projectDaysToCap({ total: 51_000, inflowPerDay: 10 }), 0);
});

// ── capacityAlarm: TIME can escalate ahead of PERCENTAGE ─────────────────

test('a low percentage with a fast fill still escalates — the runway is what matters', () => {
  // 50% full but 3,000 rows/day: 8 days out. Percentage alone would call this "ok".
  const alarm = capacityAlarm({ total: 25_000, inflowPerDay: 3_000 });
  assert.equal(classifyCapacity(25_000).level, 'ok', 'sanity: percentage alone says fine');
  assert.equal(alarm.level, 'critical', 'days-to-cap must be able to escalate on its own');
  assert.equal(alarm.urgency, 'loud');
});

test('a high percentage with NO growth still warns (a full base is fragile even if flat)', () => {
  const alarm = capacityAlarm({ total: 44_000, inflowPerDay: 0 });
  assert.equal(alarm.level, 'critical');
  assert.equal(alarm.fire, true);
  assert.match(formatCapacityDetail(alarm), /no measurable growth|not growing/i);
});

test('urgency mapping: warn is a normal ping, critical and emergency are LOUD', () => {
  assert.equal(capacityAlarm({ total: 36_451, inflowPerDay: 345 }).urgency, 'normal');
  assert.equal(capacityAlarm({ total: 43_000, inflowPerDay: 345 }).urgency, 'loud');
  assert.equal(capacityAlarm({ total: 48_000, inflowPerDay: 345 }).urgency, 'loud');
});

test('a healthy base stays SILENT — this alarm must not become background noise', () => {
  const alarm = capacityAlarm({ total: 20_000, inflowPerDay: 100 });
  assert.equal(alarm.level, 'ok');
  assert.equal(alarm.fire, false, 'a quiet base must not ping the operator daily');
});

test('watch level is observed but not paged (it belongs in the digest, not on the phone)', () => {
  const alarm = capacityAlarm({ total: AIRTABLE_RECORD_CAP * 0.62, inflowPerDay: 50 });
  assert.equal(alarm.level, 'watch');
  assert.equal(alarm.fire, false);
});

test('EMERGENCY names the actual consequence — writes failing, in plain words', () => {
  const alarm = capacityAlarm({ total: 47_600, inflowPerDay: 345 });
  assert.equal(alarm.level, 'emergency');
  const text = `${alarm.summary}\n${formatCapacityDetail(alarm)}`;
  assert.match(text, /signup|write/i, 'the operator must be told what breaks, not just a number');
  assert.match(text, /ad spend/i, 'and that money is still being spent into it');
});

test('the detail always carries the numbers an operator needs to act', () => {
  const alarm = capacityAlarm({
    total: 36_451,
    inflowPerDay: 345,
    biggestTables: [
      { table: 'Email Sends', count: 14_242 },
      { table: 'Cron Runs', count: 11_521 },
    ],
  });
  const detail = formatCapacityDetail(alarm);
  assert.match(detail, /36,?451/);
  assert.match(detail, /13,?549/, 'headroom');
  assert.match(detail, /345/, 'measured inflow');
  assert.match(detail, /Email Sends/, 'the biggest table, so the operator knows where to cut');
  assert.match(detail, /14,?242/);
});

test('dedupe keys are per-level per-day so a stable state pings once, not every run', () => {
  const a = capacityAlarm({ total: 36_451, inflowPerDay: 345, now: new Date('2026-08-19T09:10:00Z') });
  const b = capacityAlarm({ total: 36_500, inflowPerDay: 345, now: new Date('2026-08-19T21:10:00Z') });
  assert.equal(a.dedupeKey, b.dedupeKey, 'same level, same day ⇒ one alert');
  const escalated = capacityAlarm({ total: 43_000, inflowPerDay: 345, now: new Date('2026-08-19T21:10:00Z') });
  assert.notEqual(escalated.dedupeKey, a.dedupeKey, 'an ESCALATION must always get through');
});

// ── resolveRecordCap ─────────────────────────────────────────────────────

test('the cap is env-tunable (plan upgrade) and defaults to the Team-plan 50k', () => {
  const prev = process.env.AIRTABLE_RECORD_CAP;
  try {
    delete process.env.AIRTABLE_RECORD_CAP;
    assert.equal(resolveRecordCap(), 50_000);
    process.env.AIRTABLE_RECORD_CAP = '125000';
    assert.equal(resolveRecordCap(), 125_000);
    process.env.AIRTABLE_RECORD_CAP = 'banana';
    assert.equal(resolveRecordCap(), 50_000);
    process.env.AIRTABLE_RECORD_CAP = '0';
    assert.equal(resolveRecordCap(), 50_000, 'a zero cap would make every base look full');
  } finally {
    if (prev === undefined) delete process.env.AIRTABLE_RECORD_CAP;
    else process.env.AIRTABLE_RECORD_CAP = prev;
  }
});
