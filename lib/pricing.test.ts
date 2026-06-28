import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveDeposit,
  deriveLadder,
  roundTo50,
  DEPOSIT_MIN,
  DEPOSIT_PCT,
  MIN_TIER_PRICE,
} from './pricing';

// ─── deriveDeposit: the reserve invariant ────────────────────────────────
// The whole point of a deposit is a PARTIAL reserve: deposit < price so the
// buyer always owes a real balance at fulfillment. A deposit equal to the
// price (balance $0) defeats the model.

test('deriveDeposit is STRICTLY less than price at the p==100 boundary', () => {
  // Regression: pre-fix, roundTo50(100*0.25)=50, floored to DEPOSIT_MIN=100,
  // then min(100, 100) returned 100 == price (balance $0). Now capped at p-50.
  const dep = deriveDeposit(100);
  assert.ok(dep < 100, `deposit ${dep} must be < price 100`);
  assert.equal(dep, 50);
});

test('deriveDeposit stays strictly below price across the floor band', () => {
  // For any chargeable price (>= MIN_TIER_PRICE) the deposit must be < price.
  for (let p = MIN_TIER_PRICE; p <= 1000; p += 50) {
    const dep = deriveDeposit(p);
    assert.ok(dep < p, `deposit ${dep} must be < price ${p}`);
    assert.ok(dep > 0, `deposit ${dep} must be positive for price ${p}`);
  }
});

test('deriveDeposit returns ~25% rounded to $50 for normal prices', () => {
  assert.equal(deriveDeposit(2000), roundTo50(2000 * DEPOSIT_PCT)); // 500
  assert.equal(deriveDeposit(2400), roundTo50(2400 * DEPOSIT_PCT)); // 600
});

test('deriveDeposit honors the DEPOSIT_MIN floor when 25% is below it', () => {
  // price 300 → 25% = 75 → floored to DEPOSIT_MIN (100). Still < price.
  const dep = deriveDeposit(300);
  assert.equal(dep, DEPOSIT_MIN);
  assert.ok(dep < 300);
});

test('deriveDeposit returns 0 for missing/invalid price', () => {
  assert.equal(deriveDeposit(0), 0);
  assert.equal(deriveDeposit(-50), 0);
  assert.equal(deriveDeposit(NaN), 0);
});

// ─── deriveLadder sanity (unchanged behavior, guard against regressions) ──

test('deriveLadder derives half/quarter rounded to $50', () => {
  const l = deriveLadder(2000);
  assert.equal(l.whole, 2000);
  assert.equal(l.half, roundTo50(2000 * 0.55)); // 1100
  assert.equal(l.quarter, roundTo50(2000 * 0.28)); // 550
});
