import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLoginAllowedStatus,
  shouldCheckPaidReferralFallback,
  hasPaidDepositReferral,
} from './memberLoginGate';

// The allowlist the route has always enforced — case-insensitive, tolerant of
// Airtable enum objects.
test('isLoginAllowedStatus accepts approved/active/waitlisted in any casing', () => {
  assert.equal(isLoginAllowedStatus('Approved'), true);
  assert.equal(isLoginAllowedStatus('active'), true);
  assert.equal(isLoginAllowedStatus('WAITLISTED'), true);
  assert.equal(isLoginAllowedStatus({ name: 'Approved' }), true);
});

test('isLoginAllowedStatus rejects blank, pending, and rejected', () => {
  assert.equal(isLoginAllowedStatus(''), false);
  assert.equal(isLoginAllowedStatus('  '), false);
  assert.equal(isLoginAllowedStatus(undefined), false);
  assert.equal(isLoginAllowedStatus('Pending'), false);
  assert.equal(isLoginAllowedStatus('Rejected'), false);
});

// The belt only fires for BLANK Status (My Leads consumers, #511). 'Pending'
// is a real admin-actionable value and 'Rejected' is deliberate — neither may
// route around review via the referral lookup.
test('shouldCheckPaidReferralFallback fires only on blank Status', () => {
  assert.equal(shouldCheckPaidReferralFallback(''), true);
  assert.equal(shouldCheckPaidReferralFallback(undefined), true);
  assert.equal(shouldCheckPaidReferralFallback(null), true);
  assert.equal(shouldCheckPaidReferralFallback('   '), true);
  assert.equal(shouldCheckPaidReferralFallback('Pending'), false);
  assert.equal(shouldCheckPaidReferralFallback('Rejected'), false);
  assert.equal(shouldCheckPaidReferralFallback('Approved'), false);
});

test('hasPaidDepositReferral detects any referral with Deposit Paid At', () => {
  assert.equal(hasPaidDepositReferral([{ 'Deposit Paid At': '2026-07-28T00:00:00.000Z' }]), true);
  assert.equal(
    hasPaidDepositReferral([{ 'Deposit Paid At': '' }, { 'Deposit Paid At': '2026-07-28T00:00:00.000Z' }]),
    true,
  );
});

test('hasPaidDepositReferral is false for unpaid, empty, or malformed rows', () => {
  assert.equal(hasPaidDepositReferral([]), false);
  assert.equal(hasPaidDepositReferral([{ 'Deposit Paid At': '' }, {}]), false);
  assert.equal(hasPaidDepositReferral([null, undefined] as any), false);
  assert.equal(hasPaidDepositReferral(undefined as any), false);
});
