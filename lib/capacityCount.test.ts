import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countHeldReferrals, isActiveDealReferral, HELD_REFERRAL_STATUSES } from './capacityCount';

const RID = 'recRancher1';
const OTHER = 'recRancher2';

test('counts a held referral linked via Rancher', () => {
  assert.equal(countHeldReferrals(RID, [{ Status: 'Intro Sent', Rancher: [RID] }]), 1);
});

test('counts all five held statuses', () => {
  const refs = [
    { Status: 'Intro Sent', Rancher: [RID] },
    { Status: 'Rancher Contacted', Rancher: [RID] },
    { Status: 'Negotiation', Rancher: [RID] },
    { Status: 'Awaiting Payment', Rancher: [RID] },
    { Status: 'Slot Locked', Rancher: [RID] },
  ];
  assert.equal(countHeldReferrals(RID, refs), 5);
});

test('excludes Pending Approval (pre-INCR, no slot consumed)', () => {
  assert.equal(countHeldReferrals(RID, [{ Status: 'Pending Approval', Rancher: [RID] }]), 0);
});

test('excludes terminal Closed Won / Closed Lost', () => {
  const refs = [
    { Status: 'Closed Won', Rancher: [RID] },
    { Status: 'Closed Lost', Rancher: [RID] },
  ];
  assert.equal(countHeldReferrals(RID, refs), 0);
});

test('does NOT count a referral linked to a different rancher', () => {
  assert.equal(countHeldReferrals(RID, [{ Status: 'Negotiation', Rancher: [OTHER] }]), 0);
});

test('does NOT count a Suggested-Rancher-only referral (the divergence the fix closes)', () => {
  // batch-approve used to bill these to the suggested rancher; drift-check never
  // did. Canonical rule = Rancher link only, so the two reconcilers now agree.
  assert.equal(
    countHeldReferrals(RID, [{ Status: 'Rancher Contacted', 'Suggested Rancher': [RID] }]),
    0,
  );
});

test('counts when the Rancher array includes the id among several', () => {
  assert.equal(countHeldReferrals(RID, [{ Status: 'Intro Sent', Rancher: [OTHER, RID] }]), 1);
});

test('handles missing / empty / malformed link fields without throwing', () => {
  const refs = [
    { Status: 'Intro Sent' },
    { Status: 'Intro Sent', Rancher: [] },
    { Status: 'Intro Sent', Rancher: null },
    {},
    null,
  ];
  assert.equal(countHeldReferrals(RID, refs as any), 0);
});

test('Ashcraft-shape: held + large Closed Lost history returns only the held count', () => {
  const refs = [
    ...Array.from({ length: 39 }, () => ({ Status: 'Rancher Contacted', Rancher: [RID] })),
    ...Array.from({ length: 101 }, () => ({ Status: 'Closed Lost', Rancher: [RID] })),
    ...Array.from({ length: 4 }, () => ({ Status: 'Closed Won', Rancher: [RID] })),
    { Status: 'Pending Approval', Rancher: [RID] },
  ];
  assert.equal(countHeldReferrals(RID, refs), 39);
});

test('bad inputs return 0', () => {
  assert.equal(countHeldReferrals('', []), 0);
  assert.equal(countHeldReferrals(RID, null as any), 0);
});

test('HELD_REFERRAL_STATUSES is exactly the canonical 5-status set', () => {
  assert.equal(HELD_REFERRAL_STATUSES.size, 5);
  assert.ok(HELD_REFERRAL_STATUSES.has('Slot Locked'));
  assert.ok(HELD_REFERRAL_STATUSES.has('Awaiting Payment'));
  assert.ok(!HELD_REFERRAL_STATUSES.has('Pending Approval'));
  assert.ok(!HELD_REFERRAL_STATUSES.has('Closed Won'));
});

// ── isActiveDealReferral — "does this referral block a NEW match?" ──────────

test('isActiveDealReferral: every held status is an active deal', () => {
  for (const status of HELD_REFERRAL_STATUSES) {
    assert.equal(isActiveDealReferral({ Status: status }), true, status);
  }
});

test('isActiveDealReferral: Awaiting Payment and Slot Locked block a new match (BLOCKER-4)', () => {
  // The mid-payment states the old ad-hoc lists omitted — a buyer with a live
  // deposit request must NOT be double-routed or waitlisted.
  assert.equal(isActiveDealReferral({ Status: 'Awaiting Payment' }), true);
  assert.equal(isActiveDealReferral({ Status: 'Slot Locked' }), true);
});

test('isActiveDealReferral: Pending Approval counts ONLY with a linked rancher', () => {
  // Orphan Pending Approval (no Rancher / Suggested Rancher) is a failed match
  // attempt and must stay recoverable (2026-05-06 bug: 15 buyers stuck forever).
  assert.equal(isActiveDealReferral({ Status: 'Pending Approval' }), false);
  assert.equal(isActiveDealReferral({ Status: 'Pending Approval', Rancher: [] }), false);
  assert.equal(isActiveDealReferral({ Status: 'Pending Approval', Rancher: [RID] }), true);
  assert.equal(isActiveDealReferral({ Status: 'Pending Approval', 'Suggested Rancher': [RID] }), true);
});

test('isActiveDealReferral: terminal / dormant / unknown statuses are not active', () => {
  assert.equal(isActiveDealReferral({ Status: 'Closed Won' }), false);
  assert.equal(isActiveDealReferral({ Status: 'Closed Lost' }), false);
  assert.equal(isActiveDealReferral({ Status: 'Waitlisted' }), false);
  assert.equal(isActiveDealReferral({ Status: 'Dormant' }), false);
  assert.equal(isActiveDealReferral({ Status: '' }), false);
});

test('isActiveDealReferral: malformed input does not throw', () => {
  assert.equal(isActiveDealReferral(null as any), false);
  assert.equal(isActiveDealReferral(undefined as any), false);
  assert.equal(isActiveDealReferral({} as any), false);
  assert.equal(isActiveDealReferral({ Status: 'Pending Approval', Rancher: 'not-an-array' } as any), false);
});

// ── rancher-added leads NEVER consume routing capacity (My Leads, 2026-07-29) ──
// A rancher-entered lead ('Referral Source' = 'rancher-added') was never
// routed and never INCR'd — counting it would shrink the rancher's visible
// capacity for the leads BHC routes. One choke point: the canonical counter
// (and the shared per-rancher bucketing below) skip these rows, so the Redis
// seed, drift-check, batch-approve self-heal, stale-expiry resync, and
// admin/health all agree. isActiveDealReferral deliberately still counts them
// (a buyer mid-deal with their own rancher must not be double-routed).

import { heldCountsByRancher } from './capacityCount';

test('countHeldReferrals: skips rancher-added rows in every held status', () => {
  const refs = [...HELD_REFERRAL_STATUSES].map((s) => ({
    Status: s,
    Rancher: [RID],
    'Referral Source': 'rancher-added',
  }));
  assert.equal(countHeldReferrals(RID, refs), 0);
});

test('countHeldReferrals: mixed routed + rancher-added counts only routed', () => {
  const refs = [
    { Status: 'Rancher Contacted', Rancher: [RID] },
    { Status: 'Rancher Contacted', Rancher: [RID], 'Referral Source': 'rancher-added' },
    { Status: 'Negotiation', Rancher: [RID], 'Referral Source': { name: 'rancher-added' } },
  ];
  assert.equal(countHeldReferrals(RID, refs), 1);
});

test('heldCountsByRancher: same rule as countHeldReferrals, bucketed per rancher', () => {
  const counts = heldCountsByRancher([
    { Status: 'Intro Sent', Rancher: [RID] },
    { Status: 'Slot Locked', Rancher: [RID] },
    { Status: 'Rancher Contacted', Rancher: [OTHER] },
    { Status: 'Rancher Contacted', Rancher: [RID], 'Referral Source': 'rancher-added' },
    { Status: 'Pending Approval', Rancher: [RID] }, // pre-INCR — excluded
    { Status: 'Closed Won', Rancher: [RID] },       // terminal — excluded
    { Status: 'Intro Sent' },                        // unlinked — excluded
  ]);
  assert.deepEqual(counts, { [RID]: 2, [OTHER]: 1 });
});

test('heldCountsByRancher and countHeldReferrals can never disagree (drift-alarm guard)', () => {
  const refs = [
    { Status: 'Intro Sent', Rancher: [RID] },
    { Status: 'Negotiation', Rancher: [RID], 'Referral Source': 'rancher-added' },
    { Status: 'Awaiting Payment', Rancher: [RID] },
    { Status: 'Rancher Contacted', Rancher: [OTHER, RID] },
  ];
  const bucketed = heldCountsByRancher(refs);
  assert.equal(bucketed[RID] || 0, countHeldReferrals(RID, refs));
  assert.equal(bucketed[OTHER] || 0, countHeldReferrals(OTHER, refs));
});

test('isActiveDealReferral: a HELD rancher-added lead IS an active deal (no double-routing)', () => {
  // Guard (d): matching/suggest, batch-approve and stuck-buyer-recovery all
  // derive "buyer already in a deal" from this predicate — a rancher-entered
  // lead mid-conversation must block a second referral for the same buyer.
  assert.equal(
    isActiveDealReferral({ Status: 'Rancher Contacted', 'Referral Source': 'rancher-added', Rancher: [RID] }),
    true,
  );
  assert.equal(
    isActiveDealReferral({ Status: 'Negotiation', 'Referral Source': 'rancher-added', Rancher: [RID] }),
    true,
  );
});

import { countClosedWonReferrals } from './capacityCount';
test('countClosedWonReferrals: counts only Closed Won on the Rancher link', () => {
  const R='recR1';
  const refs=[
    {Status:'Closed Won', Rancher:[R]},
    {Status:'Closed Won', Rancher:[R]},
    {Status:'Intro Sent', Rancher:[R]},       // held, not a sale
    {Status:'Closed Lost', Rancher:[R]},       // lost, not a sale
    {Status:'Closed Won', Rancher:['recOTHER']},
    {Status:'Closed Won', 'Suggested Rancher':[R]}, // suggested-only never counts
  ];
  assert.equal(countClosedWonReferrals(R, refs), 2);
  assert.equal(countClosedWonReferrals('', refs), 0);
  assert.equal(countClosedWonReferrals(R, null as any), 0);
});
