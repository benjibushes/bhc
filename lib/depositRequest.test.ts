import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideDepositRequest,
  isCutTier,
  priceFieldForCut,
  depositFieldForCut,
  MIN_DEPOSIT_CENTS,
  MAX_DEPOSIT_CENTS,
  type DepositRequestInput,
} from './depositRequest';

const RANCHER = 'recRancherA';
const OTHER = 'recRancherB';

// A fully-eligible rancher with a priced Half cut + separate deposit.
function eligibleRancher(over: Record<string, any> = {}): Record<string, any> {
  return {
    'Pricing Model': 'tier_v2',
    'Stripe Connect Status': 'active',
    'Stripe Connect Account Id': 'acct_123',
    'Tier': 'Pasture',
    'Half Price': 2000,
    'Half Deposit': 500,
    'Quarter Price': 1100,
    'Whole Price': 3800,
    ...over,
  };
}

function baseInput(over: Partial<DepositRequestInput> = {}): DepositRequestInput {
  return {
    sessionRancherId: RANCHER,
    referralLinkedRancherIds: [RANCHER],
    rancher: eligibleRancher(),
    cut: 'Half',
    depositAmountDollars: null,
    ...over,
  };
}

test('happy path: uses saved deposit + full price for the cut', () => {
  const res = decideDepositRequest(baseInput());
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.decision.cut, 'Half');
  assert.equal(res.decision.fullSaleDollars, 2000);
  assert.equal(res.decision.fullSaleCents, 200000);
  assert.equal(res.decision.depositDollars, 500);
  assert.equal(res.decision.depositCents, 50000);
});

test('happy path: caller-supplied deposit overrides the saved deposit', () => {
  const res = decideDepositRequest(baseInput({ depositAmountDollars: 750 }));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.decision.depositDollars, 750);
  assert.equal(res.decision.depositCents, 75000);
});

test('ownership: referral linked to a DIFFERENT rancher → 403', () => {
  const res = decideDepositRequest(baseInput({ referralLinkedRancherIds: [OTHER] }));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 403);
});

test('ownership: empty session rancher id → 403', () => {
  const res = decideDepositRequest(baseInput({ sessionRancherId: '' }));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 403);
});

test('eligibility: legacy pricing model → 422', () => {
  const res = decideDepositRequest(
    baseInput({ rancher: eligibleRancher({ 'Pricing Model': 'legacy' }) }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 422);
});

test('eligibility: non-active Connect status → 422', () => {
  const res = decideDepositRequest(
    baseInput({ rancher: eligibleRancher({ 'Stripe Connect Status': 'onboarding' }) }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 422);
});

test('eligibility: missing Connect account id → 422', () => {
  const res = decideDepositRequest(
    baseInput({ rancher: eligibleRancher({ 'Stripe Connect Account Id': '' }) }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 422);
});

test('pricing: cut with no saved price → 422 (prevents 409 buyer dead-link)', () => {
  const res = decideDepositRequest(
    baseInput({ cut: 'Whole', rancher: eligibleRancher({ 'Whole Price': 0 }) }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 422);
});

test('amount: deposit greater than the full sale price → 400', () => {
  const res = decideDepositRequest(baseInput({ depositAmountDollars: 2500 }));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 400);
  assert.match(res.error, /can't exceed/);
});

test('amount: deposit below the $25 floor → 400', () => {
  const res = decideDepositRequest(baseInput({ depositAmountDollars: 10 }));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 400);
  assert.equal(MIN_DEPOSIT_CENTS, 2500);
});

test('amount: deposit above the $25k ceiling → 400', () => {
  // Use a cut priced high enough that the ceiling (not the > full-price rule) trips.
  const res = decideDepositRequest(
    baseInput({
      cut: 'Whole',
      rancher: eligibleRancher({ 'Whole Price': 30000 }),
      depositAmountDollars: 26000,
    }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 400);
  assert.equal(MAX_DEPOSIT_CENTS, 2_500_000);
});

test('amount: explicit non-positive deposit (0) → 400', () => {
  const res = decideDepositRequest(baseInput({ depositAmountDollars: 0 }));
  // 0 is treated as "explicit but invalid" → 400, not a fallthrough to saved.
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 400);
});

test('fallback: deposit == full price when no separate deposit configured', () => {
  const res = decideDepositRequest(
    baseInput({ cut: 'Quarter', rancher: eligibleRancher({ 'Quarter Price': 1100 }) }),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  // No Quarter Deposit field → deposit falls back to the full price.
  assert.equal(res.decision.depositDollars, 1100);
});

test('field-name helpers map each cut correctly', () => {
  assert.equal(priceFieldForCut('Quarter'), 'Quarter Price');
  assert.equal(priceFieldForCut('Half'), 'Half Price');
  assert.equal(priceFieldForCut('Whole'), 'Whole Price');
  assert.equal(depositFieldForCut('Quarter'), 'Quarter Deposit');
  assert.equal(depositFieldForCut('Half'), 'Half Deposit');
  assert.equal(depositFieldForCut('Whole'), 'Whole Deposit');
});

test('isCutTier guards bad input', () => {
  assert.equal(isCutTier('Half'), true);
  assert.equal(isCutTier('half'), false);
  assert.equal(isCutTier(''), false);
  assert.equal(isCutTier(undefined), false);
});
