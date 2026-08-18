import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKETING_TOUCH_FIELDS,
  DEFAULT_MARKETING_COOLDOWN_HOURS,
  lastMarketingTouchMs,
  cooledDown,
} from './marketingTouch';

const NOW = new Date('2026-08-18T15:00:00Z').getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60 * 1000).toISOString();

// ── Field roster (the load-bearing part — real writers, no guesses) ─────────

test('field roster: every marketing rail stamp is present', () => {
  for (const f of [
    'Campaign Last Sent At', // demand-router waves + requalify/autopilot claim
    'Campaign SMS Recovery Sent At', // demand-router SMS recovery
    'Nurture Touched At', // nurture-drip
    'Sequence Sent At', // email-sequences
    'Routing Segment Last Sent At', // email-sequences segment branch
    'Warmup Sent At', // rancher-launch warmup
  ]) {
    assert.ok(MARKETING_TOUCH_FIELDS.includes(f), `missing marketing stamp: ${f}`);
  }
});

test('field roster: chase/transactional stamps are EXCLUDED by design', () => {
  for (const f of [
    'Waiting Nudge Last Sent At', // waiting-activation quiz chase
    'Ready Nudge Last Sent At', // waiting-activation READY chase
    'Last Chased At', // referral-chasup (Referrals table anyway)
    'Buyer Pulse Sent At', // buyer-pulse (Referrals table anyway)
  ]) {
    assert.ok(!MARKETING_TOUCH_FIELDS.includes(f), `chase stamp must not gate marketing: ${f}`);
  }
});

// ── lastMarketingTouchMs ────────────────────────────────────────────────────

test('lastMarketingTouchMs: 0 for never-touched / null / garbage stamps', () => {
  assert.equal(lastMarketingTouchMs({}), 0);
  assert.equal(lastMarketingTouchMs(null), 0);
  assert.equal(lastMarketingTouchMs(undefined), 0);
  assert.equal(lastMarketingTouchMs({ 'Sequence Sent At': 'not-a-date' }), 0);
  // Non-marketing activity never counts.
  assert.equal(
    lastMarketingTouchMs({ 'Qualified At': hoursAgo(1), 'Warmup Engaged At': hoursAgo(1), Created: hoursAgo(1) }),
    0,
  );
});

test('lastMarketingTouchMs: takes the MAX across rails (stale stamp never masks a fresh one)', () => {
  const rec = {
    'Nurture Touched At': hoursAgo(200),
    'Sequence Sent At': hoursAgo(3),
    'Campaign Last Sent At': hoursAgo(100),
  };
  assert.equal(lastMarketingTouchMs(rec), NOW - 3 * 60 * 60 * 1000);
});

// ── cooledDown — the gate, both directions ─────────────────────────────────

test('cooledDown: never-touched buyer passes', () => {
  assert.equal(cooledDown({}, NOW), true);
});

test('cooledDown: BLOCKED when any rail touched within 24h — every direction', () => {
  // campaign → other rails
  assert.equal(cooledDown({ 'Campaign Last Sent At': hoursAgo(2) }, NOW), false);
  // nurture → other rails
  assert.equal(cooledDown({ 'Nurture Touched At': hoursAgo(23) }, NOW), false);
  // sequences → other rails
  assert.equal(cooledDown({ 'Sequence Sent At': hoursAgo(1) }, NOW), false);
  // warmup → other rails
  assert.equal(cooledDown({ 'Warmup Sent At': hoursAgo(12) }, NOW), false);
  // SMS recovery → other rails
  assert.equal(cooledDown({ 'Campaign SMS Recovery Sent At': hoursAgo(5) }, NOW), false);
});

test('cooledDown: ALLOWED once the window has elapsed', () => {
  assert.equal(cooledDown({ 'Campaign Last Sent At': hoursAgo(25) }, NOW), true);
  assert.equal(cooledDown({ 'Nurture Touched At': hoursAgo(24) }, NOW), true); // boundary: >= window
  assert.equal(cooledDown({ 'Warmup Sent At': hoursAgo(24.01) }, NOW), true);
});

test('cooledDown: chase stamps are exempt (a chased buyer is still marketable)', () => {
  assert.equal(
    cooledDown({ 'Waiting Nudge Last Sent At': hoursAgo(1), 'Ready Nudge Last Sent At': hoursAgo(1) }, NOW),
    true,
  );
});

test('cooledDown: a FUTURE stamp (clock skew / bad write) fails closed — blocked', () => {
  assert.equal(cooledDown({ 'Sequence Sent At': hoursAgo(-2) }, NOW), false);
});

test('cooledDown: custom window honored', () => {
  assert.equal(cooledDown({ 'Sequence Sent At': hoursAgo(30) }, NOW, 48), false);
  assert.equal(cooledDown({ 'Sequence Sent At': hoursAgo(50) }, NOW, 48), true);
});

test('default cooldown is 24h', () => {
  assert.equal(DEFAULT_MARKETING_COOLDOWN_HOURS, 24);
});
