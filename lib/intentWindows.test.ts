// lib/intentWindows.test.ts
//
// P5′ (MARKETING-REVAMP-2026-08 §5, Track 1) — tiered intent windows.
// These tests PIN the panel-amended pressure policy:
//
//   quiz            7-day window · max 3 touches · ~48h spacing (days 0/2/4)
//   deposit-invite  14-day window · max 5 touches · ramping spacing
//                   (days 1/3/6/9/13 — median quiz→close is 2-21d and ~90% of
//                   considered conversions land by day 12; the old flat cap-2
//                   closed before our own median buyer decides)
//   decay           after the window: ONE final touch inside the following
//                   7 days, then done forever.
//
// The planner is PURE and only answers "is a touch due right now" — the crons
// keep their own claim-before-send stamps, caps, and suppression checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sprintPlanFor,
  INTENT_WINDOW_POLICIES,
  type SprintPlan,
} from './intentWindows';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-08-01T12:00:00Z');
const days = (n: number) => T0 + n * DAY;

function plan(
  kind: 'quiz' | 'deposit-invite',
  touches: number,
  nowDays: number,
  lastTouchDays?: number | null,
): SprintPlan {
  return sprintPlanFor(kind, T0, touches, days(nowDays), {
    lastTouchAt: lastTouchDays === undefined || lastTouchDays === null ? null : days(lastTouchDays),
  });
}

// ── policy table pins ───────────────────────────────────────────────────────

test('policy: quiz = 7d window, 3 touches, offsets 0/2/4', () => {
  const p = INTENT_WINDOW_POLICIES.quiz;
  assert.equal(p.windowDays, 7);
  assert.equal(p.maxTouches, 3);
  assert.deepEqual([...p.touchOffsetsDays], [0, 2, 4]);
  assert.equal(p.decayDays, 7);
});

test('policy: deposit-invite = 14d window, 5 touches, ramping offsets 1/3/6/9/13', () => {
  const p = INTENT_WINDOW_POLICIES['deposit-invite'];
  assert.equal(p.windowDays, 14);
  assert.equal(p.maxTouches, 5);
  assert.deepEqual([...p.touchOffsetsDays], [1, 3, 6, 9, 13]);
  assert.equal(p.decayDays, 7);
});

// ── quiz sprint ─────────────────────────────────────────────────────────────

test('quiz: touch 1 due immediately at intent', () => {
  assert.deepEqual(plan('quiz', 0, 0), { due: true, exhausted: false, tier: 'sprint' });
});

test('quiz: touch 2 not due before day 2, due at day 2', () => {
  assert.equal(plan('quiz', 1, 1, 0).due, false);
  assert.deepEqual(plan('quiz', 1, 2, 0), { due: true, exhausted: false, tier: 'sprint' });
});

test('quiz: touch 3 due at day 4 with 48h since touch 2', () => {
  assert.equal(plan('quiz', 2, 3, 2).due, false);
  assert.deepEqual(plan('quiz', 2, 4, 2), { due: true, exhausted: false, tier: 'sprint' });
});

test('quiz: ~48h spacing holds even when a touch fired late', () => {
  // Touch 2 landed late (day 5). Touch 3's day-4 offset is already past, but
  // the 2-day gap versus the LAST touch still gates it.
  assert.equal(plan('quiz', 2, 6, 5).due, false);
  assert.equal(plan('quiz', 2, 7, 5).due, true);
});

test('quiz: sprint budget spent (3 touches) → silent until decay, NOT exhausted', () => {
  const p = plan('quiz', 3, 5, 4);
  assert.deepEqual(p, { due: false, exhausted: false, tier: 'sprint' });
});

// ── quiz decay ──────────────────────────────────────────────────────────────

test('quiz: decay tier between day 7 and day 14', () => {
  assert.equal(plan('quiz', 3, 8, 4).tier, 'decay');
  assert.equal(plan('quiz', 3, 14, 4).tier, 'decay');
});

test('quiz: ONE decay touch due after the window (>=48h since last touch)', () => {
  assert.deepEqual(plan('quiz', 3, 8, 4), { due: true, exhausted: false, tier: 'decay' });
});

test('quiz: decay touch already sent (last touch inside decay) → exhausted', () => {
  const p = plan('quiz', 4, 10, 8);
  assert.deepEqual(p, { due: false, exhausted: true, tier: 'decay' });
});

test('quiz: decay touch respects 48h gap against a boundary-hugging sprint touch', () => {
  // Last sprint touch day 6.5, window ends day 7 — day 7.5 is decay but only
  // 1 day since the last touch: hold.
  assert.equal(plan('quiz', 3, 7.5, 6.5).due, false);
  assert.equal(plan('quiz', 3, 8.6, 6.5).due, true);
});

test('quiz: decay allows the final touch even when sprint under-delivered', () => {
  // Only 1 touch ever sent (cron outage) — decay still grants exactly one
  // final touch, not a restart of the sprint.
  const p = plan('quiz', 1, 9, 0);
  assert.deepEqual(p, { due: true, exhausted: false, tier: 'decay' });
});

// ── quiz done ───────────────────────────────────────────────────────────────

test('quiz: past day 14 → done + exhausted, forever', () => {
  assert.deepEqual(plan('quiz', 3, 15, 4), { due: false, exhausted: true, tier: 'done' });
  assert.deepEqual(plan('quiz', 0, 400), { due: false, exhausted: true, tier: 'done' });
});

// ── deposit-invite sprint ───────────────────────────────────────────────────

test('deposit-invite: NOT due before day 1 (the invite email gets its 24h shot)', () => {
  assert.equal(plan('deposit-invite', 0, 0.5).due, false);
});

test('deposit-invite: touch 1 due at day 1', () => {
  assert.deepEqual(plan('deposit-invite', 0, 1), { due: true, exhausted: false, tier: 'sprint' });
});

test('deposit-invite: ramp — touches due at days 3, 6, 9, 13', () => {
  assert.deepEqual(plan('deposit-invite', 1, 3, 1), { due: true, exhausted: false, tier: 'sprint' });
  assert.deepEqual(plan('deposit-invite', 2, 6, 3), { due: true, exhausted: false, tier: 'sprint' });
  assert.deepEqual(plan('deposit-invite', 3, 9, 6), { due: true, exhausted: false, tier: 'sprint' });
  assert.deepEqual(plan('deposit-invite', 4, 13, 9), { due: true, exhausted: false, tier: 'sprint' });
});

test('deposit-invite: within the ramp gap → not due (day 8 after a day-6 touch)', () => {
  assert.equal(plan('deposit-invite', 3, 8, 6).due, false);
});

test('deposit-invite: late touch still honors the ramp gap vs last touch', () => {
  // Touch 4 fired late on day 11; touch 5's offset (13) has passed by day 13
  // but the 4-day gap (9→13) holds until day 15.
  assert.equal(plan('deposit-invite', 4, 13, 11).due, false);
  assert.equal(plan('deposit-invite', 4, 15, 11).due, true);
});

test('deposit-invite: 5 sprint touches spent → silent, NOT exhausted (decay ahead)', () => {
  assert.deepEqual(plan('deposit-invite', 5, 13.5, 13), {
    due: false,
    exhausted: false,
    tier: 'sprint',
  });
});

test('deposit-invite: decay touch due once in days 14-21, then exhausted', () => {
  assert.deepEqual(plan('deposit-invite', 5, 16, 13), { due: true, exhausted: false, tier: 'decay' });
  // Decay touch sent day 16 → nothing further, ever.
  assert.deepEqual(plan('deposit-invite', 6, 18, 16), { due: false, exhausted: true, tier: 'decay' });
  assert.deepEqual(plan('deposit-invite', 6, 30, 16), { due: false, exhausted: true, tier: 'done' });
});

test('deposit-invite: past day 21 with no decay touch → done anyway (never late-fire)', () => {
  assert.deepEqual(plan('deposit-invite', 5, 22, 13), { due: false, exhausted: true, tier: 'done' });
});

// ── lifetime bound ──────────────────────────────────────────────────────────

test('touch count at/over maxTouches+1 is exhausted in every tier', () => {
  assert.equal(plan('quiz', 4, 5, 4).exhausted, true);
  assert.equal(plan('quiz', 4, 5, 4).due, false);
  assert.equal(plan('deposit-invite', 6, 10, 9).exhausted, true);
  assert.equal(plan('deposit-invite', 7, 16, 15).due, false);
});

// ── fail-closed edges ───────────────────────────────────────────────────────

test('unparseable/missing intentAt → fail closed (done + exhausted)', () => {
  for (const bad of ['', 'not-a-date', null, undefined]) {
    const p = sprintPlanFor('quiz', bad as any, 0, T0);
    assert.deepEqual(p, { due: false, exhausted: true, tier: 'done' });
  }
});

test('future intentAt (corrupt/clock skew) → silent, not exhausted', () => {
  const p = sprintPlanFor('deposit-invite', days(5), 0, T0);
  assert.deepEqual(p, { due: false, exhausted: false, tier: 'sprint' });
});

test('touches>0 with missing/corrupt lastTouchAt → fail closed (never storm)', () => {
  // Spacing can't be verified without the last-touch anchor — hold.
  assert.equal(plan('quiz', 1, 3, null).due, false);
  assert.equal(plan('deposit-invite', 2, 7, null).due, false);
  assert.equal(
    sprintPlanFor('quiz', T0, 1, days(3), { lastTouchAt: 'garbage' as any }).due,
    false,
  );
  // Decay leg too: can't prove the one-shot wasn't already sent.
  assert.equal(plan('quiz', 2, 9, null).due, false);
});

test('garbage touch counts are treated as 0, never NaN-poisoned', () => {
  const p = sprintPlanFor('quiz', T0, Number('x'), T0);
  assert.deepEqual(p, { due: true, exhausted: false, tier: 'sprint' });
  assert.equal(sprintPlanFor('quiz', T0, -3, T0).due, true);
});

test('string ISO intentAt and Date lastTouchAt both parse', () => {
  const p = sprintPlanFor('quiz', '2026-08-01T12:00:00Z', 1, days(2), {
    lastTouchAt: new Date(T0),
  });
  assert.deepEqual(p, { due: true, exhausted: false, tier: 'sprint' });
});
