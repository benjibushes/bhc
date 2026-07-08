// lib/staleHolds.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/staleHolds.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStaleHold, selectStaleHolds, freedByRancher, DEFAULT_STALE_DAYS } from './staleHolds';

const NOW = new Date('2026-07-08T12:00:00Z').getTime();
const days = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const stale = (over: any = {}) => ({
  id: 'rec1',
  Status: 'Intro Sent',
  'Intro Sent At': days(30),
  _createdTime: days(35),
  ...over,
});

test('expires a 30-day-silent Intro Sent hold', () => {
  assert.equal(isStaleHold(stale(), NOW), true);
});

test('Rancher Contacted expires too; money-adjacent statuses NEVER do', () => {
  assert.equal(isStaleHold(stale({ Status: 'Rancher Contacted' }), NOW), true);
  for (const s of ['Negotiation', 'Awaiting Payment', 'Slot Locked', 'Closed Won', 'Pending Approval']) {
    assert.equal(isStaleHold(stale({ Status: s }), NOW), false, s);
  }
});

test('ANY deposit signal blocks expiry', () => {
  assert.equal(isStaleHold(stale({ 'Deposit Requested At': days(25) }), NOW), false);
  assert.equal(isStaleHold(stale({ 'Deposit Paid At': days(25) }), NOW), false);
  assert.equal(isStaleHold(stale({ 'Deposit Amount': 600 }), NOW), false);
});

test('recent activity from EITHER side resets the clock', () => {
  assert.equal(isStaleHold(stale({ 'Last Buyer Activity At': days(5) }), NOW), false);
  assert.equal(isStaleHold(stale({ 'Last Rancher Activity At': days(2) }), NOW), false);
  assert.equal(isStaleHold(stale({ 'Last Rancher Activity At': days(22) }), NOW), true);
});

test('exactly at the boundary does not expire; just past it does', () => {
  assert.equal(isStaleHold(stale({ 'Intro Sent At': days(DEFAULT_STALE_DAYS) }), NOW), false);
  assert.equal(isStaleHold(stale({ 'Intro Sent At': days(DEFAULT_STALE_DAYS + 1) }), NOW), true);
});

test('no timestamps at all → never guess, never expire', () => {
  assert.equal(isStaleHold({ id: 'x', Status: 'Intro Sent' } as any, NOW), false);
});

test('selectStaleHolds: oldest first, capped', () => {
  const rows = [
    stale({ id: 'newer', 'Intro Sent At': days(25) }),
    stale({ id: 'oldest', 'Intro Sent At': days(90) }),
    stale({ id: 'fresh', 'Intro Sent At': days(3) }),
    stale({ id: 'mid', 'Intro Sent At': days(40) }),
  ];
  const picked = selectStaleHolds(rows as any, NOW, { cap: 2 });
  assert.deepEqual(picked.map((r) => r.id), ['oldest', 'mid']);
});

test('freedByRancher groups by first Rancher link', () => {
  const rows = [
    stale({ Rancher: ['recA'] }),
    stale({ Rancher: ['recA'] }),
    stale({ Rancher: ['recB'] }),
    stale({}),
  ];
  assert.deepEqual(freedByRancher(rows as any), { recA: 2, recB: 1, '(unlinked)': 1 });
});
