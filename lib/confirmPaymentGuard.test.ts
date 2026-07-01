import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasPendingStripeDeposit } from './confirmPaymentGuard';

test('pending Stripe deposit: requested, not yet paid → true (block confirm)', () => {
  assert.equal(
    hasPendingStripeDeposit({ 'Deposit Requested At': '2026-06-30T10:00:00Z', 'Deposit Paid At': '' }),
    true,
  );
});

test('paid Stripe deposit: requested AND paid → false (real deposit settled)', () => {
  assert.equal(
    hasPendingStripeDeposit({
      'Deposit Requested At': '2026-06-30T10:00:00Z',
      'Deposit Paid At': '2026-06-30T11:00:00Z',
    }),
    false,
  );
});

test('off-platform Awaiting Payment: never requested a deposit → false (allow confirm)', () => {
  assert.equal(hasPendingStripeDeposit({}), false);
  assert.equal(hasPendingStripeDeposit({ 'Deposit Requested At': '', 'Deposit Paid At': '' }), false);
});

test('handles null/undefined field values safely', () => {
  assert.equal(hasPendingStripeDeposit({ 'Deposit Requested At': null, 'Deposit Paid At': null }), false);
  assert.equal(hasPendingStripeDeposit({ 'Deposit Requested At': undefined }), false);
});
