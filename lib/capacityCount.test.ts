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
