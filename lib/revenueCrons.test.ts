// Pure-logic tests for the revenue crons (final-invoice-dunning +
// stuck-referral-reaper). Importing the route modules pulls lib/secrets, which
// fail-fast on missing env — so we set the required secrets BEFORE importing.
// Only the side-effect-free selector functions are exercised here; no Airtable /
// Stripe / Resend calls are made.

process.env.JWT_SECRET ||= 'test-secret-ci';
process.env.ADMIN_PASSWORD ||= 'test-admin';
process.env.CRON_SECRET ||= 'test-cron';
process.env.INTERNAL_API_SECRET ||= 'test-internal';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isDunningEligible,
  selectDunningEligible,
  dunningTouchCount,
  shouldEscalateDunning,
  DUNNING_EXCLUDED_STATUSES,
} from '@/app/api/cron/final-invoice-dunning/route';

import {
  isStuckPendingRancher,
  selectStuckPendingRancher,
  needsStatusNormalize,
  referralAgeMs,
  LEGACY_PENDING_STATUS,
  CANONICAL_PENDING_STATUS,
  PENDING_RANCHER_APPROVAL,
} from '@/app/api/cron/stuck-referral-reaper/route';

const NOW = Date.parse('2026-06-28T12:00:00Z');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

// ─── final-invoice-dunning ────────────────────────────────────────────────

test('dunning: eligible when invoice aged + Awaiting Payment + never reminded', () => {
  const ref = {
    'Final Invoice Sent At': daysAgo(5),
    'Final Invoice URL': 'https://checkout.stripe.com/abc',
    Status: 'Awaiting Payment',
  };
  assert.equal(isDunningEligible(ref, { now: NOW }), true);
});

test('dunning: NOT eligible before the stuck window', () => {
  const ref = {
    'Final Invoice Sent At': daysAgo(1),
    'Final Invoice URL': 'https://checkout.stripe.com/abc',
    Status: 'Awaiting Payment',
  };
  assert.equal(isDunningEligible(ref, { now: NOW, stuckDays: 3 }), false);
});

test('dunning: NOT eligible without a pay link', () => {
  const ref = {
    'Final Invoice Sent At': daysAgo(10),
    'Final Invoice URL': '',
    Status: 'Awaiting Payment',
  };
  assert.equal(isDunningEligible(ref, { now: NOW }), false);
});

test('dunning: closed/refunded deals are never dunned', () => {
  for (const status of ['Closed Won', 'Closed Lost', 'Refunded']) {
    const ref = {
      'Final Invoice Sent At': daysAgo(10),
      'Final Invoice URL': 'https://checkout.stripe.com/abc',
      Status: status,
    };
    assert.equal(isDunningEligible(ref, { now: NOW }), false, `${status} should be excluded`);
    assert.equal(DUNNING_EXCLUDED_STATUSES.has(status), true);
  }
});

test('dunning: throttle suppresses a too-recent reminder', () => {
  const ref = {
    'Final Invoice Sent At': daysAgo(20),
    'Final Invoice URL': 'https://checkout.stripe.com/abc',
    Status: 'Awaiting Payment',
    'Final Invoice Reminded At': daysAgo(1),
  };
  assert.equal(isDunningEligible(ref, { now: NOW, intervalDays: 3 }), false);
  // ...but eligible again once the interval has elapsed.
  ref['Final Invoice Reminded At'] = daysAgo(4);
  assert.equal(isDunningEligible(ref, { now: NOW, intervalDays: 3 }), true);
});

test('dunning: selectDunningEligible filters a mixed batch', () => {
  const batch = [
    { id: 'a', 'Final Invoice Sent At': daysAgo(5), 'Final Invoice URL': 'x', Status: 'Awaiting Payment' },
    { id: 'b', 'Final Invoice Sent At': daysAgo(5), 'Final Invoice URL': 'x', Status: 'Closed Won' },
    { id: 'c', 'Final Invoice Sent At': daysAgo(1), 'Final Invoice URL': 'x', Status: 'Awaiting Payment' },
  ];
  const got = selectDunningEligible(batch, { now: NOW, stuckDays: 3 }).map((r) => r.id);
  assert.deepEqual(got, ['a']);
});

test('dunning: touch count + escalation threshold', () => {
  assert.equal(dunningTouchCount({}), 0);
  assert.equal(dunningTouchCount({ 'Final Invoice Reminder Count': 2 }), 2);
  // pre-increment: 0 prior + this touch = 1; escalateAfter 3 → not yet.
  assert.equal(shouldEscalateDunning({ 'Final Invoice Reminder Count': 0 }, { escalateAfter: 3 }), false);
  // 2 prior + this touch = 3 → escalate.
  assert.equal(shouldEscalateDunning({ 'Final Invoice Reminder Count': 2 }, { escalateAfter: 3 }), true);
});

// ─── stuck-referral-reaper ────────────────────────────────────────────────

test('stuck: eligible when Pending Rancher Response is aged past window', () => {
  const ref = {
    'Approval Status': PENDING_RANCHER_APPROVAL,
    Status: 'Pending Approval',
    'Created At': daysAgo(7),
  };
  assert.equal(isStuckPendingRancher(ref, { now: NOW, stuckDays: 5 }), true);
});

test('stuck: NOT eligible before the window', () => {
  const ref = {
    'Approval Status': PENDING_RANCHER_APPROVAL,
    Status: 'Pending Approval',
    'Created At': daysAgo(2),
  };
  assert.equal(isStuckPendingRancher(ref, { now: NOW, stuckDays: 5 }), false);
});

test('stuck: never reap an already-closed referral', () => {
  for (const status of ['Closed Won', 'Closed Lost', 'Refunded']) {
    const ref = {
      'Approval Status': PENDING_RANCHER_APPROVAL,
      Status: status,
      'Created At': daysAgo(30),
    };
    assert.equal(isStuckPendingRancher(ref, { now: NOW }), false, `${status} should not reap`);
  }
});

test('stuck: ignores rows not awaiting rancher response', () => {
  const ref = {
    'Approval Status': 'approved',
    Status: 'Intro Sent',
    'Created At': daysAgo(30),
  };
  assert.equal(isStuckPendingRancher(ref, { now: NOW }), false);
});

test('stuck: unknown age is never reaped blindly', () => {
  const ref = { 'Approval Status': PENDING_RANCHER_APPROVAL, Status: 'Pending Approval' };
  assert.equal(referralAgeMs(ref, NOW), -1);
  assert.equal(isStuckPendingRancher(ref, { now: NOW }), false);
});

test('stuck: falls back to _createdTime when Created At missing', () => {
  const ref = {
    'Approval Status': PENDING_RANCHER_APPROVAL,
    Status: 'Pending Approval',
    _createdTime: daysAgo(10),
  };
  assert.equal(isStuckPendingRancher(ref, { now: NOW, stuckDays: 5 }), true);
});

test('stuck: selectStuckPendingRancher filters a mixed batch', () => {
  const batch = [
    { id: 'a', 'Approval Status': PENDING_RANCHER_APPROVAL, Status: 'Pending Approval', 'Created At': daysAgo(9) },
    { id: 'b', 'Approval Status': PENDING_RANCHER_APPROVAL, Status: 'Closed Lost', 'Created At': daysAgo(9) },
    { id: 'c', 'Approval Status': 'approved', Status: 'Intro Sent', 'Created At': daysAgo(9) },
    { id: 'd', 'Approval Status': PENDING_RANCHER_APPROVAL, Status: 'Pending Approval', 'Created At': daysAgo(1) },
  ];
  const got = selectStuckPendingRancher(batch, { now: NOW, stuckDays: 5 }).map((r) => r.id);
  assert.deepEqual(got, ['a']);
});

test('stuck: status normalization predicate targets legacy Pending only', () => {
  assert.equal(LEGACY_PENDING_STATUS, 'Pending');
  assert.equal(CANONICAL_PENDING_STATUS, 'Pending Approval');
  assert.equal(needsStatusNormalize({ Status: 'Pending' }), true);
  assert.equal(needsStatusNormalize({ Status: 'Pending Approval' }), false);
  assert.equal(needsStatusNormalize({ Status: 'Closed Won' }), false);
});
