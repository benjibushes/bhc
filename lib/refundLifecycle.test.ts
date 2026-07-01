import { test } from 'node:test';
import assert from 'node:assert/strict';
// Import from refundLifecycle (pure, zero imports) — NOT from lib/contracts/
// payments or the route, which drag in airtable/secrets at import time.
import {
  refundReferralClearFields,
  canSendFinalInvoice,
  FINAL_INVOICE_BLOCKED_STATUSES,
} from './refundLifecycle';

const NOW = '2026-07-01T12:00:00.000Z';
const DEPOSIT_STAMP = '2026-06-20T09:30:00.000Z';

// ── C2 part 1: a full refund must fully reset the deposit/accept lifecycle ───
test('refund clears Deposit Paid At + Rancher Accepted At (C2: stale stamp re-arms final invoice + NRD lock)', () => {
  const updates = refundReferralClearFields(NOW);
  // The two fields the shipped code forgot — leaving them stamped lets a
  // rancher send a balance invoice to a refunded buyer, and blocks re-deposit.
  assert.ok('Deposit Paid At' in updates, 'must explicitly clear Deposit Paid At');
  assert.equal(updates['Deposit Paid At'], null);
  assert.ok('Rancher Accepted At' in updates, 'must explicitly clear Rancher Accepted At');
  assert.equal(updates['Rancher Accepted At'], null);
});

test('refund keeps the existing Closed Won teardown intact', () => {
  const updates = refundReferralClearFields(NOW);
  assert.equal(updates['Status'], 'Refunded');
  assert.equal(updates['Closed At'], null);
  assert.equal(updates['Sale Amount'], null);
  assert.equal(updates['Commission Due'], null);
  assert.equal(updates['Commission Status'], null);
  assert.equal(updates['Refunded At'], NOW);
});

test('refund updates use explicit null (idempotent Airtable clear), never undefined', () => {
  const updates = refundReferralClearFields(NOW);
  for (const [field, value] of Object.entries(updates)) {
    // undefined keys get dropped by JSON serialization and would silently NOT
    // clear the field on webhook retries; null is Airtable's explicit clear.
    assert.notEqual(value, undefined, `${field} must not be undefined`);
  }
});

// ── C2 part 2: send gate must reject refunded / closed-lost referrals ────────
test('canSendFinalInvoice REJECTS a Refunded referral even with a stale deposit stamp', () => {
  // This is the exact production bug: refund left Deposit Paid At set, and the
  // route gated on !!Deposit Paid At alone → Stripe emailed a full balance
  // invoice to a buyer who owes nothing.
  const gate = canSendFinalInvoice('Refunded', DEPOSIT_STAMP);
  assert.equal(gate.ok, false, 'Refunded referral must never receive a final invoice');
  if (!gate.ok) {
    assert.equal(gate.reason, 'blocked-status');
    assert.match(gate.message, /refund/i);
  }
});

test('canSendFinalInvoice REJECTS a Closed Lost referral even with a deposit stamp', () => {
  const gate = canSendFinalInvoice('Closed Lost', DEPOSIT_STAMP);
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.equal(gate.reason, 'blocked-status');
});

test('canSendFinalInvoice still enforces the U18 deposit-settled gate', () => {
  for (const missing of [null, undefined, '']) {
    const gate = canSendFinalInvoice('Deposit Paid', missing);
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.reason, 'deposit-unpaid');
  }
});

test('canSendFinalInvoice ALLOWS the legitimate paid-deposit path', () => {
  // Normal lifecycle statuses with a settled deposit must keep working.
  for (const status of ['Deposit Paid', 'Awaiting Payment', 'Slot Locked', '']) {
    assert.deepEqual(canSendFinalInvoice(status, DEPOSIT_STAMP), { ok: true });
  }
});

test('blocked-status list is exactly Refunded + Closed Lost (no scope creep into eligibility)', () => {
  assert.deepEqual([...FINAL_INVOICE_BLOCKED_STATUSES].sort(), ['Closed Lost', 'Refunded']);
});
