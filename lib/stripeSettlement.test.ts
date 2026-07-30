import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDepositCents, payingBuyerConsumerPatch } from './stripeSettlement';

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

// ── payingBuyerConsumerPatch — stage flip + blank-Status backfill ───────────

const NOW = '2026-07-29T00:00:00.000Z';

// Portal-lockout fix (2026-07-29): a My Leads consumer (#511) is created with
// Buyer Stage=MATCHED and a deliberately BLANK Status. When they pay a
// deposit, the patch must backfill Status='Approved' (login allowlist) even
// though the stage flip itself is a no-op.
test('payingBuyerConsumerPatch backfills Approved onto a blank Status without re-flipping MATCHED', () => {
  const patch = payingBuyerConsumerPatch('MATCHED', '', NOW);
  assert.deepEqual(patch, { 'Status': 'Approved', 'Approved At': NOW });
  // undefined / whitespace count as blank too
  assert.equal(payingBuyerConsumerPatch('MATCHED', undefined, NOW)['Status'], 'Approved');
  assert.equal(payingBuyerConsumerPatch('MATCHED', '  ', NOW)['Status'], 'Approved');
});

// A paying buyer must NEVER have an existing Status overwritten — Rejected is
// a deliberate admin decision; Approved/Active/Waitlisted are already fine.
test('payingBuyerConsumerPatch never overwrites an existing Status', () => {
  for (const s of ['Approved', 'Active', 'Waitlisted', 'Pending', 'Rejected']) {
    const patch = payingBuyerConsumerPatch('MATCHED', s, NOW);
    assert.equal('Status' in patch, false, `Status "${s}" must not be touched`);
    assert.equal('Approved At' in patch, false);
  }
});

// The #512 stage flip survives unchanged: pre-payment stages flip to MATCHED
// with the paired Updated At + denorm.
test('payingBuyerConsumerPatch flips a stale pre-payment stage to MATCHED', () => {
  for (const stage of ['', 'READY', 'WAITING', undefined]) {
    const patch = payingBuyerConsumerPatch(stage, 'Approved', NOW);
    assert.equal(patch['Buyer Stage'], 'MATCHED');
    assert.equal(patch['Buyer Stage Updated At'], NOW);
    assert.equal(patch['Referral Status'], 'Awaiting Payment');
  }
});

// Both concerns compose into one write for a stale-stage + blank-Status buyer.
test('payingBuyerConsumerPatch composes stage flip and Status backfill', () => {
  const patch = payingBuyerConsumerPatch('READY', '', NOW);
  assert.equal(patch['Buyer Stage'], 'MATCHED');
  assert.equal(patch['Status'], 'Approved');
});

// Fully-settled buyer (MATCHED/CLOSED + real Status) → nothing to write; the
// caller skips the Airtable update entirely.
test('payingBuyerConsumerPatch returns {} when nothing needs writing', () => {
  assert.deepEqual(payingBuyerConsumerPatch('MATCHED', 'Approved', NOW), {});
  assert.deepEqual(payingBuyerConsumerPatch('CLOSED', 'Active', NOW), {});
});

// Airtable singleSelect can come back as {name} — both fields must tolerate it.
test('payingBuyerConsumerPatch reads Airtable enum objects', () => {
  assert.deepEqual(payingBuyerConsumerPatch({ name: 'MATCHED' }, { name: 'Approved' }, NOW), {});
  assert.equal(payingBuyerConsumerPatch({ name: 'MATCHED' }, '', NOW)['Status'], 'Approved');
});
