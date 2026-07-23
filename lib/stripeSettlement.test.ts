import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDepositCents } from './stripeSettlement';

// Rancher-portion deposit stamped as a string (see lib/stripeConnect.ts:
// depositCents: String(input.amountCents)). Prefer it over the total charged.
test('resolveDepositCents prefers stamped depositCents over total charged', () => {
  // deposit $500, buyer charged $540 (deposit + $40 BHC fee).
  assert.equal(resolveDepositCents('50000', 54000), 50000);
  assert.equal(resolveDepositCents(50000, 54000), 50000);
});

// The overstatement bug: missing/blank metadata must fall back to the total
// charged, but that total INCLUDES the fee — so the recorded deposit would be
// inflated. We can't recover the split here, but the fallback must still be the
// total (never crash) and clamped so it can't exceed the charge.
test('resolveDepositCents falls back to total charged only when truly absent', () => {
  assert.equal(resolveDepositCents(undefined, 54000), 54000);
  assert.equal(resolveDepositCents(null, 54000), 54000);
  assert.equal(resolveDepositCents('', 54000), 54000);
  assert.equal(resolveDepositCents('not-a-number', 54000), 54000);
});

// A legit deposit of 0 is NOT "absent" — the old `|| totalChargedCents`
// truthiness fallback would wrongly inflate it to the full charge.
test('resolveDepositCents treats 0 as present, not absent', () => {
  assert.equal(resolveDepositCents('0', 54000), 0);
  assert.equal(resolveDepositCents(0, 54000), 0);
});

// Clamp: a malformed/oversized metadata value can never record a deposit
// larger than what was actually charged.
test('resolveDepositCents clamps to total charged', () => {
  assert.equal(resolveDepositCents('99999', 54000), 54000);
  assert.equal(resolveDepositCents(60000, 54000), 54000);
});
