// lib/staleHolds.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/staleHolds.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStaleHold,
  selectStaleHolds,
  freedByRancher,
  DEFAULT_STALE_DAYS,
  EXPIRABLE_STATUSES,
  staleDaysForStatus,
} from './staleHolds';
import { HELD_REFERRAL_STATUSES } from './capacityCount';

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

test('Rancher Contacted expires too; MONEY-COMMITTED statuses NEVER do', () => {
  assert.equal(isStaleHold(stale({ Status: 'Rancher Contacted' }), NOW), true);
  // 'Negotiation' moved OUT of this list 2026-07-25 — it holds capacity, so it
  // must have SOME expiry path. Awaiting Payment / Slot Locked stay untouchable.
  for (const s of ['Awaiting Payment', 'Slot Locked', 'Closed Won', 'Closed Lost', 'Dormant', 'Pending Approval']) {
    assert.equal(isStaleHold(stale({ Status: s, 'Intro Sent At': days(400) }), NOW), false, s);
  }
});

// ── 'Negotiation' expiry (pause-asymmetry sweep 2026-07-25) ────────────────
// The leak: Negotiation holds a capacity slot (HELD_REFERRAL_STATUSES) but no
// expiry path could release it. 24 live referrals were parked there.

test('INVARIANT: every capacity-holding status is either expirable or money-committed', () => {
  const MONEY_COMMITTED = new Set(['Awaiting Payment', 'Slot Locked']);
  for (const s of HELD_REFERRAL_STATUSES) {
    assert.equal(
      EXPIRABLE_STATUSES.has(s) || MONEY_COMMITTED.has(s),
      true,
      `${s} holds capacity but has no expiry path and is not money-committed`,
    );
  }
});

// Fixture where the newest signal of ANY kind is exactly `age` days old, so
// the window boundary is the only thing under test (the shared `stale()`
// helper bakes in a 35-day _createdTime that would otherwise dominate).
const silentFor = (age: number, over: any = {}) => ({
  id: 'rec1',
  Status: 'Negotiation',
  'Intro Sent At': days(age),
  _createdTime: days(age + 5),
  ...over,
});

test('Negotiation expires — but only past its OWN longer window', () => {
  const base = DEFAULT_STALE_DAYS; // 21
  // Past the intro window but inside the negotiation window → still held.
  assert.equal(isStaleHold(silentFor(30), NOW), false);
  assert.equal(isStaleHold(silentFor(base * 2), NOW), false);
  // Just past 2× → released.
  assert.equal(isStaleHold(silentFor(base * 2 + 1), NOW), true);
  // Same age, an unanswered intro, releases far earlier.
  assert.equal(isStaleHold(silentFor(30, { Status: 'Intro Sent' }), NOW), true);
});

test('Negotiation window scales with the STALE_HOLD_DAYS override, not a hardcode', () => {
  assert.equal(staleDaysForStatus('Negotiation', 21), 42);
  assert.equal(staleDaysForStatus('Negotiation', 10), 20);
  assert.equal(staleDaysForStatus('Intro Sent', 21), 21);
  assert.equal(staleDaysForStatus('Rancher Contacted', 21), 21);
  // Unknown status falls back to the base window (×1), never to Infinity/NaN.
  assert.equal(staleDaysForStatus('Whatever', 21), 21);
  // With a 10-day base the negotiation window is 20d.
  assert.equal(isStaleHold(silentFor(25), NOW, 10), true);
  assert.equal(isStaleHold(silentFor(15), NOW, 10), false);
});

test('a deposit signal blocks Negotiation expiry at ANY age', () => {
  assert.equal(isStaleHold(silentFor(400), NOW), true); // control
  assert.equal(isStaleHold(silentFor(400, { 'Deposit Requested At': days(390) }), NOW), false);
  assert.equal(isStaleHold(silentFor(400, { 'Deposit Paid At': days(390) }), NOW), false);
  assert.equal(isStaleHold(silentFor(400, { 'Deposit Amount': 600 }), NOW), false);
});

test('recent activity keeps a Negotiation alive even past 2x the base window', () => {
  assert.equal(isStaleHold(silentFor(400, { 'Last Buyer Activity At': days(3) }), NOW), false);
  assert.equal(isStaleHold(silentFor(400, { 'Last Rancher Activity At': days(40) }), NOW), false);
  assert.equal(isStaleHold(silentFor(400, { 'Last Rancher Activity At': days(43) }), NOW), true);
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

test('selectStaleHolds: oldest first, capped, unlinked rows excluded', () => {
  const rows = [
    stale({ id: 'newer', 'Intro Sent At': days(25), Rancher: ['recA'] }),
    stale({ id: 'oldest', 'Intro Sent At': days(90), Rancher: ['recA'] }),
    stale({ id: 'fresh', 'Intro Sent At': days(3), Rancher: ['recA'] }),
    stale({ id: 'mid', 'Intro Sent At': days(40), Rancher: ['recA'] }),
    stale({ id: 'unlinked', 'Intro Sent At': days(200) }), // no Rancher → frees nothing → excluded
  ];
  const picked = selectStaleHolds(rows as any, NOW, { cap: 2 });
  assert.deepEqual(picked.map((r) => r.id), ['oldest', 'mid']);
});

test('selectStaleHolds: capacity-blocked ranchers jump the queue', () => {
  const rows = [
    stale({ id: 'old-noop', 'Intro Sent At': days(90), Rancher: ['recIdle'] }),
    stale({ id: 'newer-blocked', 'Intro Sent At': days(25), Rancher: ['recFull'] }),
    stale({ id: 'mid-noop', 'Intro Sent At': days(40), Rancher: ['recIdle'] }),
  ];
  const picked = selectStaleHolds(rows as any, NOW, { cap: 2, priorityRancherIds: new Set(['recFull']) });
  assert.deepEqual(picked.map((r) => r.id), ['newer-blocked', 'old-noop']);
});

// ── My Leads (2026-07-29): rancher-entered leads NEVER auto-expire ─────────
// A rancher's own customer ('Referral Source' = 'rancher-added') can sit
// quiet for months — market-season timing is the rancher's business. Flipping
// them Dormant after 21 silent days would delete the rancher's pipeline.

test('a rancher-added lead never expires, at any age, in any expirable status', () => {
  for (const status of EXPIRABLE_STATUSES) {
    const row = stale({
      Status: status,
      'Intro Sent At': days(400),
      'Referral Source': 'rancher-added',
      Rancher: ['recR'],
    });
    assert.equal(isStaleHold(row as any, NOW), false, status);
  }
});

test('rancher-added exclusion tolerates the Airtable {name} read shape', () => {
  const row = stale({ 'Referral Source': { name: 'rancher-added' }, Rancher: ['recR'] });
  assert.equal(isStaleHold(row as any, NOW), false);
});

test('selectStaleHolds drops rancher-added rows while keeping routed ones', () => {
  const rows = [
    stale({ id: 'routed', Rancher: ['recA'] }),
    stale({ id: 'crm', Rancher: ['recA'], 'Referral Source': 'rancher-added' }),
  ];
  const picked = selectStaleHolds(rows as any, NOW, { cap: 10 });
  assert.deepEqual(picked.map((r) => r.id), ['routed']);
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
