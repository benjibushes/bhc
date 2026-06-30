import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDepositCapableMatch } from './depositOptionality';

// The cash-leak fix hinges on this one decision: a qualified buyer matched to a
// tier_v2 (Stripe-Connect) rancher WITH a referralId must be offered a deposit
// (deposit-primary CTA + quiet call). Everything else stays call-only. These
// tests pin the branch so a future refactor can't silently re-introduce the
// call-only-for-Connect leak.

test('tier_v2 + referralId → deposit-capable (deposit-primary path)', () => {
  assert.equal(isDepositCapableMatch('tier_v2', 'rec123'), true);
});

test('tier_v2 WITHOUT referralId → NOT deposit-capable (call fallback)', () => {
  // No referral means the deposit deep-link has nothing to charge against, so
  // we must NOT mint a dead deposit link — fall back to the call invite.
  assert.equal(isDepositCapableMatch('tier_v2', null), false);
  assert.equal(isDepositCapableMatch('tier_v2', undefined), false);
  assert.equal(isDepositCapableMatch('tier_v2', ''), false);
});

test('legacy rancher → NOT deposit-capable even with a referralId (call path)', () => {
  // Legacy / non-Connect ranchers genuinely cannot take a self-serve deposit.
  assert.equal(isDepositCapableMatch('legacy', 'rec123'), false);
});

test('Operator-without-Connect (non tier_v2) → NOT deposit-capable', () => {
  assert.equal(isDepositCapableMatch('operator', 'rec123'), false);
});

test('missing / empty pricing model → NOT deposit-capable', () => {
  assert.equal(isDepositCapableMatch(undefined, 'rec123'), false);
  assert.equal(isDepositCapableMatch(null, 'rec123'), false);
  assert.equal(isDepositCapableMatch('', 'rec123'), false);
});
