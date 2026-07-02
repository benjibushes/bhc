import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedReferralUiState } from './referralClosedState';

// The deposit endpoints 409 with error='referral_closed' + the referral's
// Status. The deposit page must NOT render "you're already reserved ✓" when
// the reservation is dead (Closed Lost / Refunded / Lost) — that leaves a
// buyer waiting for beef that never comes.

test('Closed Lost → inactive (honest state, never "already reserved")', () => {
  assert.equal(closedReferralUiState('Closed Lost'), 'inactive');
});

test('Refunded → inactive', () => {
  assert.equal(closedReferralUiState('Refunded'), 'inactive');
});

test('Lost (reserve-void status) → inactive', () => {
  assert.equal(closedReferralUiState('Lost'), 'inactive');
});

test('case/whitespace-insensitive', () => {
  assert.equal(closedReferralUiState('  closed lost '), 'inactive');
  assert.equal(closedReferralUiState('REFUNDED'), 'inactive');
});

test('paid/held states keep the positive reserved state', () => {
  assert.equal(closedReferralUiState('Slot Locked'), 'reserved');
  assert.equal(closedReferralUiState('Closed Won'), 'reserved');
  assert.equal(closedReferralUiState('Awaiting Payment'), 'reserved');
});

test('missing/unknown status defaults to reserved (matches prior behavior)', () => {
  assert.equal(closedReferralUiState(''), 'reserved');
  assert.equal(closedReferralUiState(undefined), 'reserved');
  assert.equal(closedReferralUiState(null), 'reserved');
  assert.equal(closedReferralUiState('Pending'), 'reserved');
});
