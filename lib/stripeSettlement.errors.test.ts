import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermanentSettlementError, isPermanentSettlementError } from './stripeSettlement';

// The webhook uses isPermanentSettlementError to decide 5xx (retry the
// transient blip so a paid deposit self-heals) vs 200 (permanent data bug —
// stop Stripe's 3-day redelivery). Getting this wrong either orphans real
// money or creates a redelivery storm, so it's worth pinning down.

test('PermanentSettlementError is flagged permanent', () => {
  const e = new PermanentSettlementError('buyer_deposit missing required ids');
  assert.equal(isPermanentSettlementError(e), true);
  assert.equal(e.permanent, true);
  assert.equal(e.name, 'PermanentSettlementError');
  assert.ok(e instanceof Error);
});

test('a plain (transient) Error is NOT permanent → webhook returns 5xx and retries', () => {
  assert.equal(isPermanentSettlementError(new Error('Airtable 429 rate limit')), false);
  assert.equal(isPermanentSettlementError(new Error('referral unreadable — aborting to avoid double-settle')), false);
});

test('handles null/undefined/non-error inputs safely', () => {
  assert.equal(isPermanentSettlementError(null), false);
  assert.equal(isPermanentSettlementError(undefined), false);
  assert.equal(isPermanentSettlementError('missing ids'), false);
  assert.equal(isPermanentSettlementError({ permanent: false }), false);
  assert.equal(isPermanentSettlementError({ permanent: true }), true);
});
