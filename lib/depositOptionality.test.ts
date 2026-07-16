import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDepositCapableMatch } from './depositOptionality';

// The cash-leak fix hinges on this one decision: a qualified buyer matched to a
// tier_v2 (Stripe-Connect ACTIVE) rancher WITH a referralId must be offered a
// deposit (deposit-primary CTA + quiet call). Everything else stays call-only.
// These tests pin the branch so a future refactor can't silently re-introduce
// either leak:
//   - call-only-for-Connect (the original 2026-06-30 cash leak), or
//   - dead deposit CTA for a tier_v2 rancher whose Connect onboarding never
//     finished (the link hard-409s at app/api/checkout/deposit/route.ts:155).

test('tier_v2 + Connect active + referralId → deposit-capable (deposit-primary path)', () => {
  assert.equal(isDepositCapableMatch('tier_v2', 'rec123', 'active'), true);
});

test('tier_v2 + referralId but Connect NOT active → NOT deposit-capable (dead-CTA guard)', () => {
  // Pricing Model flips to tier_v2 before Connect onboarding completes. Until
  // Stripe Connect Status === 'active' the deposit endpoint 409s — minting the
  // CTA would ship a guaranteed-broken primary button.
  assert.equal(isDepositCapableMatch('tier_v2', 'rec123', 'onboarding'), false);
  assert.equal(isDepositCapableMatch('tier_v2', 'rec123', 'pending'), false);
  assert.equal(isDepositCapableMatch('tier_v2', 'rec123', ''), false);
  assert.equal(isDepositCapableMatch('tier_v2', 'rec123', null), false);
  assert.equal(isDepositCapableMatch('tier_v2', 'rec123', undefined), false);
});

test('Connect status is case-insensitive (mirrors isRancherOnConnect)', () => {
  assert.equal(isDepositCapableMatch('tier_v2', 'rec123', 'Active'), true);
  assert.equal(isDepositCapableMatch('tier_v2', 'rec123', 'ACTIVE'), true);
});

test('tier_v2 WITHOUT referralId → NOT deposit-capable (call fallback)', () => {
  // No referral means the deposit deep-link has nothing to charge against, so
  // we must NOT mint a dead deposit link — fall back to the call invite.
  assert.equal(isDepositCapableMatch('tier_v2', null, 'active'), false);
  assert.equal(isDepositCapableMatch('tier_v2', undefined, 'active'), false);
  assert.equal(isDepositCapableMatch('tier_v2', '', 'active'), false);
});

test('legacy rancher → NOT deposit-capable even with a referralId (call path)', () => {
  // Legacy / non-Connect ranchers genuinely cannot take a self-serve deposit.
  assert.equal(isDepositCapableMatch('legacy', 'rec123', 'active'), false);
});

test('Operator-without-Connect (non tier_v2) → NOT deposit-capable', () => {
  assert.equal(isDepositCapableMatch('operator', 'rec123', 'active'), false);
});

test('missing / empty pricing model → NOT deposit-capable', () => {
  assert.equal(isDepositCapableMatch(undefined, 'rec123', 'active'), false);
  assert.equal(isDepositCapableMatch(null, 'rec123', 'active'), false);
  assert.equal(isDepositCapableMatch('', 'rec123', 'active'), false);
});
