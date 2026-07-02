import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveDeposit,
  deriveLadder,
  depositDisplay,
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

// ─── depositDisplay: fee-invisible buyer display math ──────────────────────
// Founder directive (2026-07-01): the buyer sees ONE price — dueNowCents,
// the deposit with BHC commission already baked in. This helper is DISPLAY
// ONLY; the charge path (POST /api/checkout/deposit + createDepositCheckout)
// keeps its own math. These tests pin the helper byte-for-byte to that charge
// math so what the page/storefront shows is exactly what the card is charged.

test('depositDisplay mirrors the charge path: derived deposit + fee on full price', () => {
  // price $2000, no stored deposit, 7% pasture rate:
  // deposit = deriveDeposit(2000) = $500 → 50000c
  // fee     = round(200000 × 0.07) = 14000c (POST: round(fullSaleCents × rate))
  // dueNow  = 64000c — the ONE buyer-facing number
  // balance = 200000 − 50000 = 150000c (paid rancher-direct)
  const d = depositDisplay(2000, null, 0.07);
  assert.ok(d);
  assert.equal(d!.depositCents, 50000);
  assert.equal(d!.feeCents, 14000);
  assert.equal(d!.dueNowCents, 64000);
  assert.equal(d!.balanceCents, 150000);
});

test('depositDisplay honors a valid stored deposit (0 < dep ≤ price)', () => {
  const d = depositDisplay(2000, 800, 0.03);
  assert.ok(d);
  assert.equal(d!.depositCents, 80000);
  assert.equal(d!.feeCents, 6000);       // 3% of 200000c
  assert.equal(d!.dueNowCents, 86000);
  assert.equal(d!.balanceCents, 120000);
});

test('depositDisplay falls back to deriveDeposit on invalid stored deposits', () => {
  // Same resolution as GET buildCut + POST: stored must be finite, > 0, ≤ price.
  for (const bad of [0, -100, 2001, NaN, undefined, null]) {
    const d = depositDisplay(2000, bad as any, 0.07);
    assert.ok(d, `price 2000 stored=${bad} must still build`);
    assert.equal(d!.depositCents, deriveDeposit(2000) * 100, `stored=${bad} falls back to derived`);
  }
});

test('depositDisplay zero-rate tier (operator): dueNow IS the deposit', () => {
  const d = depositDisplay(2400, 600, 0);
  assert.ok(d);
  assert.equal(d!.feeCents, 0);
  assert.equal(d!.dueNowCents, d!.depositCents);
  assert.equal(d!.dueNowCents, 60000);
});

test('depositDisplay returns null for missing/invalid price', () => {
  assert.equal(depositDisplay(0, null, 0.07), null);
  assert.equal(depositDisplay(-500, 100, 0.07), null);
  assert.equal(depositDisplay(NaN, 100, 0.07), null);
});

test('depositDisplay invariants: dueNow = deposit + fee, balance = full − deposit', () => {
  for (let p = MIN_TIER_PRICE + 50; p <= 3500; p += 350) {
    for (const rate of [0, 0.03, 0.07, 0.10]) {
      const d = depositDisplay(p, null, rate);
      assert.ok(d, `price ${p} rate ${rate}`);
      assert.equal(d!.dueNowCents, d!.depositCents + d!.feeCents);
      assert.equal(d!.balanceCents, Math.round(p * 100) - d!.depositCents);
      assert.ok(d!.depositCents > 0 && d!.balanceCents > 0, 'partial-reserve invariant holds');
    }
  }
});

test('depositDisplay fee rounding matches POST ordering (cents first, then rate)', () => {
  // POST: fullSaleCents = round(price×100) THEN fee = round(fullSaleCents × rate).
  // A cents-bearing price pins the ordering: 1234.56 → 123456c → round(123456×0.07) = 8642.
  const d = depositDisplay(1234.56, 600, 0.07);
  assert.ok(d);
  assert.equal(d!.feeCents, Math.round(Math.round(1234.56 * 100) * 0.07)); // 8642
});
