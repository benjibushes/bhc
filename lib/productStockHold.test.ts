import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stockIsTracked, availableAfterHolds, holdFits } from './productStockHold';

// Mirrors the Orders Left read in lib/productBuyGates: undefined/null/'' mean
// "this product doesn't track stock" — the hold machinery must stay out of the
// way entirely.
test('stockIsTracked matches the gate\'s Orders Left semantics', () => {
  assert.equal(stockIsTracked(undefined), false);
  assert.equal(stockIsTracked(null), false);
  assert.equal(stockIsTracked(''), false);
  assert.equal(stockIsTracked(0), true);
  assert.equal(stockIsTracked('0'), true);
  assert.equal(stockIsTracked(3), true);
});

test('availableAfterHolds subtracts active holds from Orders Left', () => {
  assert.equal(availableAfterHolds(5, 2), 3);
  assert.equal(availableAfterHolds(1, 0), 1);
  assert.equal(availableAfterHolds(1, 1), 0);
});

// Holds can transiently exceed stock (expired-but-uncleaned holds, an admin
// lowering Orders Left mid-flight) — available must clamp at 0, never negative.
test('availableAfterHolds clamps at zero and survives junk input', () => {
  assert.equal(availableAfterHolds(1, 5), 0);
  assert.equal(availableAfterHolds(0, 0), 0);
  assert.equal(availableAfterHolds(3, -2), 3); // negative holds treated as none
  assert.equal(availableAfterHolds(NaN, 0), 0);
});

// THE last-unit race: both buyers INCR; the counter serializes them. First
// sees total=1 <= left=1 (fits); second sees total=2 > 1 (refused).
test('holdFits admits exactly one of two simultaneous last-unit buyers', () => {
  const ordersLeft = 1;
  assert.equal(holdFits(ordersLeft, 1), true); // winner's post-INCR total
  assert.equal(holdFits(ordersLeft, 2), false); // loser's post-INCR total
});

test('holdFits handles multi-quantity carts against remaining stock', () => {
  // 3 left, buyer A holds 2 (total 2 fits), buyer B wants 2 (total 4 refused)
  assert.equal(holdFits(3, 2), true);
  assert.equal(holdFits(3, 4), false);
  // exact fill is allowed
  assert.equal(holdFits(3, 3), true);
});

test('holdFits refuses on non-finite inputs (never mints on garbage)', () => {
  assert.equal(holdFits(NaN, 1), false);
  assert.equal(holdFits(1, NaN), false);
});
