import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueNurtureTouch, NURTURE_TOUCHES } from './nurtureDrip';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-08T12:00:00Z');
const qualifiedDaysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

const base = {
  buyerStage: 'WAITING',
  qualifiedAt: qualifiedDaysAgo(3),
  email: 'buyer@x.com',
  nurtureTouch: 0,
  hasActiveDeal: false,
};

test('drip: touch 1 due at day 2+, not before', () => {
  assert.equal(dueNurtureTouch({ ...base, qualifiedAt: qualifiedDaysAgo(1) }, NOW), null);
  assert.equal(dueNurtureTouch({ ...base, qualifiedAt: qualifiedDaysAgo(2.1) }, NOW)?.touch, 1);
});

test('drip: monotonic — never skips ahead even when far overdue', () => {
  // Qualified 30 days ago, nothing sent: next is STILL touch 1.
  assert.equal(dueNurtureTouch({ ...base, qualifiedAt: qualifiedDaysAgo(30) }, NOW)?.touch, 1);
  // Touch 1 sent: next is touch 2.
  assert.equal(dueNurtureTouch({ ...base, qualifiedAt: qualifiedDaysAgo(30), nurtureTouch: 1 }, NOW)?.touch, 2);
});

test('drip: each touch waits for its own day', () => {
  // Touch 2 needs day 6 — at day 4 with touch 1 sent, nothing due.
  assert.equal(dueNurtureTouch({ ...base, qualifiedAt: qualifiedDaysAgo(4), nurtureTouch: 1 }, NOW), null);
  assert.equal(dueNurtureTouch({ ...base, qualifiedAt: qualifiedDaysAgo(6), nurtureTouch: 1 }, NOW)?.touch, 2);
  assert.equal(dueNurtureTouch({ ...base, qualifiedAt: qualifiedDaysAgo(12), nurtureTouch: 2 }, NOW)?.touch, 3);
  assert.equal(dueNurtureTouch({ ...base, qualifiedAt: qualifiedDaysAgo(21), nurtureTouch: 3 }, NOW)?.touch, 4);
});

test('drip: terminal after touch 4 — never fires again', () => {
  assert.equal(dueNurtureTouch({ ...base, qualifiedAt: qualifiedDaysAgo(400), nurtureTouch: 4 }, NOW), null);
});

test('drip: routed buyers are out immediately', () => {
  assert.equal(dueNurtureTouch({ ...base, hasActiveDeal: true }, NOW), null);
});

test('drip: only WAITING/READY stages, needs email + Qualified At', () => {
  assert.equal(dueNurtureTouch({ ...base, buyerStage: 'MATCHED' }, NOW), null);
  assert.equal(dueNurtureTouch({ ...base, buyerStage: 'CLOSED' }, NOW), null);
  assert.equal(dueNurtureTouch({ ...base, buyerStage: 'READY' }, NOW)?.touch, 1);
  assert.equal(dueNurtureTouch({ ...base, email: '' }, NOW), null);
  assert.equal(dueNurtureTouch({ ...base, email: 'junk' }, NOW), null);
  assert.equal(dueNurtureTouch({ ...base, qualifiedAt: '' }, NOW), null);
  assert.equal(dueNurtureTouch({ ...base, qualifiedAt: 'garbage' }, NOW), null);
});

test('drip: junk Nurture Touch values treated as none-sent', () => {
  assert.equal(dueNurtureTouch({ ...base, nurtureTouch: NaN }, NOW)?.touch, 1);
  assert.equal(dueNurtureTouch({ ...base, nurtureTouch: -3 }, NOW)?.touch, 1);
});

test('drip: schedule sanity — 4 ordered touches, cadence ≤ 2/week (frequency guard safe)', () => {
  assert.equal(NURTURE_TOUCHES.length, 4);
  const days = NURTURE_TOUCHES.map((t) => t.day);
  assert.deepEqual([...days].sort((a, b) => a - b), days);
  // No two touches within 3 days of each other → can't trip the 3/week cap
  for (let i = 1; i < days.length; i++) assert.ok(days[i] - days[i - 1] >= 3);
});
