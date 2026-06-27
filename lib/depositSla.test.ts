import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSlaEligible,
  selectSlaEligible,
  hoursSinceDeposit,
  isRefundedOrDisputed,
  DEFAULT_SLA_HOURS,
  DEFAULT_REPING_COOLDOWN_HOURS,
} from './depositSla';

const NOW = Date.parse('2026-06-27T12:00:00.000Z');
const HOUR = 3_600_000;
const hoursAgo = (h: number) => new Date(NOW - h * HOUR).toISOString();

test('eligible: deposit paid 5h ago, not accepted, never re-pinged', () => {
  assert.equal(
    isSlaEligible(
      { 'Deposit Paid At': hoursAgo(5), Status: 'Awaiting Payment' },
      { now: NOW },
    ),
    true,
  );
});

test('NOT eligible: no Deposit Paid At', () => {
  assert.equal(isSlaEligible({ Status: 'Awaiting Payment' }, { now: NOW }), false);
});

test('NOT eligible: rancher already accepted', () => {
  assert.equal(
    isSlaEligible(
      { 'Deposit Paid At': hoursAgo(10), 'Rancher Accepted At': hoursAgo(2), Status: 'Slot Locked' },
      { now: NOW },
    ),
    false,
  );
});

test('NOT eligible: deposit too recent (under SLA window)', () => {
  assert.equal(
    isSlaEligible(
      { 'Deposit Paid At': hoursAgo(DEFAULT_SLA_HOURS - 1), Status: 'Awaiting Payment' },
      { now: NOW },
    ),
    false,
  );
});

test('boundary: just under the SLA window is NOT eligible', () => {
  // 1s younger than the window — must not fire yet.
  const justUnder = new Date(NOW - (DEFAULT_SLA_HOURS * HOUR - 1000)).toISOString();
  assert.equal(isSlaEligible({ 'Deposit Paid At': justUnder, Status: 'Awaiting Payment' }, { now: NOW }), false);
});

test('boundary: exactly at the SLA window IS eligible (>= window fires)', () => {
  // age === slaHours exactly: `age < window` is false, so it qualifies. We want
  // a deposit that has reached the window to be chased, not skipped.
  assert.equal(
    isSlaEligible(
      { 'Deposit Paid At': hoursAgo(DEFAULT_SLA_HOURS), Status: 'Awaiting Payment' },
      { now: NOW },
    ),
    true,
  );
});

test('NOT eligible: re-pinged within cooldown', () => {
  assert.equal(
    isSlaEligible(
      {
        'Deposit Paid At': hoursAgo(30),
        'Rancher Re-pinged At': hoursAgo(DEFAULT_REPING_COOLDOWN_HOURS - 1),
        Status: 'Awaiting Payment',
      },
      { now: NOW },
    ),
    false,
  );
});

test('eligible again: re-pinged longer ago than cooldown', () => {
  assert.equal(
    isSlaEligible(
      {
        'Deposit Paid At': hoursAgo(50),
        'Rancher Re-pinged At': hoursAgo(DEFAULT_REPING_COOLDOWN_HOURS + 1),
        Status: 'Awaiting Payment',
      },
      { now: NOW },
    ),
    true,
  );
});

test('NOT eligible: terminal status Closed Won', () => {
  assert.equal(
    isSlaEligible({ 'Deposit Paid At': hoursAgo(10), Status: 'Closed Won' }, { now: NOW }),
    false,
  );
});

test('NOT eligible: terminal status Closed Lost', () => {
  assert.equal(
    isSlaEligible({ 'Deposit Paid At': hoursAgo(10), Status: 'Closed Lost' }, { now: NOW }),
    false,
  );
});

test('eligible: Slot Locked status but somehow no Rancher Accepted At still chases (defensive)', () => {
  // If status drifted to Slot Locked without the accept stamp, the missing
  // accept stamp is the canonical signal — still chase.
  assert.equal(
    isSlaEligible({ 'Deposit Paid At': hoursAgo(10), Status: 'Slot Locked' }, { now: NOW }),
    true,
  );
});

test('custom slaHours respected', () => {
  assert.equal(
    isSlaEligible({ 'Deposit Paid At': hoursAgo(3), Status: 'Awaiting Payment' }, { now: NOW, slaHours: 2 }),
    true,
  );
  assert.equal(
    isSlaEligible({ 'Deposit Paid At': hoursAgo(3), Status: 'Awaiting Payment' }, { now: NOW, slaHours: 6 }),
    false,
  );
});

test('selectSlaEligible filters a mixed list', () => {
  const refs = [
    { id: 'a', 'Deposit Paid At': hoursAgo(5), Status: 'Awaiting Payment' },                       // eligible
    { id: 'b', 'Deposit Paid At': hoursAgo(5), 'Rancher Accepted At': hoursAgo(1), Status: 'Slot Locked' }, // accepted
    { id: 'c', 'Deposit Paid At': hoursAgo(1), Status: 'Awaiting Payment' },                       // too recent
    { id: 'd', 'Deposit Paid At': hoursAgo(30), 'Rancher Re-pinged At': hoursAgo(2), Status: 'Awaiting Payment' }, // cooldown
    { id: 'e', Status: 'Awaiting Payment' },                                                       // no deposit
  ];
  const eligible = selectSlaEligible(refs, { now: NOW });
  assert.deepEqual(eligible.map((r) => r.id), ['a']);
});

test('selectSlaEligible handles empty / malformed input without throwing', () => {
  assert.deepEqual(selectSlaEligible([], { now: NOW }), []);
  // @ts-expect-error — exercising malformed runtime input
  assert.deepEqual(selectSlaEligible(undefined, { now: NOW }), []);
  assert.equal(
    isSlaEligible({ 'Deposit Paid At': 'not-a-date', Status: 'Awaiting Payment' }, { now: NOW }),
    false,
  );
});

test('hoursSinceDeposit computes whole hours', () => {
  assert.equal(hoursSinceDeposit({ 'Deposit Paid At': hoursAgo(7) }, NOW), 7);
  assert.equal(hoursSinceDeposit({}, NOW), 0);
});

// ── BLOCKER fix: refunded / disputed deposits must never be re-pinged ────────

test('BLOCKER: refunded Awaiting-Payment deposit (Payments Refunded At set) is NOT eligible', () => {
  // The exact failure case from review: refund in the NRD window leaves the
  // Referral as Awaiting Payment with Deposit Paid At still set (the Referral
  // is NOT flipped — only the Payments row records the refund).
  const ref = {
    id: 'recRefunded',
    'Deposit Paid At': hoursAgo(10),
    Status: 'Awaiting Payment',
    __payment: { 'Refunded At': hoursAgo(2), Status: 'refunded' },
  };
  assert.equal(isSlaEligible(ref, { now: NOW }), false);
});

test('refunded via Payments Status=refunded only (no Refunded At) is NOT eligible', () => {
  const ref = {
    'Deposit Paid At': hoursAgo(10),
    Status: 'Awaiting Payment',
    __payment: { Status: 'refunded' },
  };
  assert.equal(isSlaEligible(ref, { now: NOW }), false);
});

test('partial refund (Payments Refunded At set, Status still succeeded) is NOT eligible', () => {
  const ref = {
    'Deposit Paid At': hoursAgo(10),
    Status: 'Awaiting Payment',
    __payment: { 'Refunded At': hoursAgo(1), Status: 'succeeded' },
  };
  assert.equal(isSlaEligible(ref, { now: NOW }), false);
});

test('disputed deposit (Payments Dispute Status set) is NOT eligible', () => {
  const ref = {
    'Deposit Paid At': hoursAgo(10),
    Status: 'Awaiting Payment',
    __payment: { Status: 'succeeded', 'Dispute Status': 'needs_response' },
  };
  assert.equal(isSlaEligible(ref, { now: NOW }), false);
});

test('referral-side Refunded At (Closed Won refund path) is NOT eligible', () => {
  // Defense-in-depth: even with no __payment attached, the Referral-side stamp
  // (set by restoreReferralAfterRefund on the Closed Won path) excludes it.
  assert.equal(
    isSlaEligible(
      { 'Deposit Paid At': hoursAgo(10), Status: 'Awaiting Payment', 'Refunded At': hoursAgo(3) },
      { now: NOW },
    ),
    false,
  );
});

test('Status Refunded / Cancelled / Expired are excluded', () => {
  for (const status of ['Refunded', 'Cancelled', 'Canceled', 'Expired']) {
    assert.equal(
      isSlaEligible({ 'Deposit Paid At': hoursAgo(10), Status: status }, { now: NOW }),
      false,
      `status ${status} should be excluded`,
    );
  }
});

test('clean (not refunded/disputed) deposit with a succeeded payment IS still eligible', () => {
  const ref = {
    'Deposit Paid At': hoursAgo(10),
    Status: 'Awaiting Payment',
    __payment: { Status: 'succeeded' },
  };
  assert.equal(isSlaEligible(ref, { now: NOW }), true);
});

test('isRefundedOrDisputed: direct unit coverage', () => {
  assert.equal(isRefundedOrDisputed({ __payment: { 'Refunded At': hoursAgo(1) } }), true);
  assert.equal(isRefundedOrDisputed({ __payment: { Status: 'refunded' } }), true);
  assert.equal(isRefundedOrDisputed({ __payment: { 'Dispute Status': 'lost' } }), true);
  assert.equal(isRefundedOrDisputed({ 'Refunded At': hoursAgo(1) }), true);
  assert.equal(isRefundedOrDisputed({ 'Dispute Status': 'won' }), true);
  assert.equal(isRefundedOrDisputed({ __payment: { Status: 'succeeded' } }), false);
  assert.equal(isRefundedOrDisputed({ __payment: null }), false);
  assert.equal(isRefundedOrDisputed({}), false);
});

test('selectSlaEligible filters out a refunded row in a mixed list', () => {
  const refs = [
    { id: 'clean', 'Deposit Paid At': hoursAgo(6), Status: 'Awaiting Payment', __payment: { Status: 'succeeded' } },
    { id: 'refunded', 'Deposit Paid At': hoursAgo(6), Status: 'Awaiting Payment', __payment: { 'Refunded At': hoursAgo(1) } },
    { id: 'disputed', 'Deposit Paid At': hoursAgo(6), Status: 'Awaiting Payment', __payment: { 'Dispute Status': 'needs_response' } },
  ];
  assert.deepEqual(selectSlaEligible(refs, { now: NOW }).map((r) => r.id), ['clean']);
});
