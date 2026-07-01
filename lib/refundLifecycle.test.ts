import { test } from 'node:test';
import assert from 'node:assert/strict';
// Import from refundLifecycle (pure, zero imports) — NOT from lib/contracts/
// payments or the route, which drag in airtable/secrets at import time.
import {
  refundReferralClearFields,
  canSendFinalInvoice,
  FINAL_INVOICE_BLOCKED_STATUSES,
  shouldDecrementOnRefundRestore,
  shouldDecrementOnClose,
} from './refundLifecycle';
// Zero-dep canonical held-slot definition — safe under tsx --test.
import { HELD_REFERRAL_STATUSES } from './capacityCount';

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

// ── C4: full refund must NOT double-decrement rancher capacity ───────────────
// recordClose already frees the slot when a deal transitions to Closed Won
// (prior status ∈ its active set). The refund restore then decremented AGAIN,
// unconditionally → counter drifts BELOW the true held count → the matcher
// over-books a genuinely-full rancher, compounding on every close→refund cycle.
test('Closed Won at refund time → NO decrement (C4: recordClose already freed the slot)', () => {
  // The exact production bug: restoreReferralAfterRefund only proceeds from
  // Closed Won, and Closed Won holds no slot — so the decrement must never fire.
  assert.equal(shouldDecrementOnRefundRestore('Closed Won'), false);
});

test('each held status at refund time → decrement (slot was still occupied)', () => {
  // Literal list from HELD_REFERRAL_STATUSES (lib/capacityCount.ts), spelled
  // out so a silent edit to the canonical set shows up as a diff here too.
  for (const held of ['Intro Sent', 'Rancher Contacted', 'Negotiation', 'Awaiting Payment', 'Slot Locked']) {
    assert.equal(shouldDecrementOnRefundRestore(held), true, `${held} still holds a slot — refund must free it`);
  }
});

test('gate stays in lockstep with the canonical HELD_REFERRAL_STATUSES set', () => {
  for (const s of HELD_REFERRAL_STATUSES) {
    assert.equal(shouldDecrementOnRefundRestore(s), true, `${s} is canonically held`);
  }
});

test('unknown / empty / non-held statuses → NO decrement (never drift down on uncertainty)', () => {
  // 'Pending Approval' is in recordClose's ACTIVE_REF_STATES but NOT in the
  // canonical held set — the capacity INCR fires at Intro Sent, so a
  // Pending Approval referral never occupied a Redis slot to give back.
  // 'Refunded' doubles as the double-webhook-redelivery guard: even if the
  // already-Refunded early-return were bypassed, the gate refuses a second hit.
  for (const s of ['Refunded', 'Closed Lost', 'Pending Approval', 'Deposit Paid', 'Totally Bogus', '', null, undefined]) {
    assert.equal(shouldDecrementOnRefundRestore(s), false, `${String(s)} must not decrement`);
  }
});

// ── Wave-2 audit: close-path capacity gate (mirror of the C4 refund gate) ────
// The DECR decision on EVERY close path (recordClose, rancher dashboard PATCH,
// rancher pass action, admin PATCH) must derive from the ONE canonical held
// set. Pre-fix, recordClose + the routes gated on ACTIVE_REF_STATES
// (Intro Sent / Rancher Contacted / Negotiation / Pending Approval), which
//   (a) includes 'Pending Approval' → DECR of a slot that was never INCR'd
//       (INCR fires at Intro Sent) → counter drifts DOWN → over-booking;
//   (b) excludes 'Awaiting Payment' + 'Slot Locked' → closing from those
//       skipped the DECR → counter drifts UP → phantom-full ranchers.
test('each held status → Closed Won/Lost close frees the slot (fixes drift-UP / phantom-full)', () => {
  // Literal list from HELD_REFERRAL_STATUSES (lib/capacityCount.ts), spelled
  // out so a silent edit to the canonical set shows up as a diff here too.
  for (const held of ['Intro Sent', 'Rancher Contacted', 'Negotiation', 'Awaiting Payment', 'Slot Locked']) {
    assert.equal(shouldDecrementOnClose(held, 'Closed Won'), true, `${held} → Closed Won must free the slot`);
    assert.equal(shouldDecrementOnClose(held, 'Closed Lost'), true, `${held} → Closed Lost must free the slot`);
  }
});

test('Awaiting Payment / Slot Locked closes DECR (the exact wave-2 drift-UP defect)', () => {
  // Pre-fix these two were NOT in ACTIVE_REF_STATES → close skipped the DECR
  // → the Redis mirror kept charging the rancher for a terminal referral.
  assert.equal(shouldDecrementOnClose('Awaiting Payment', 'Closed Won'), true);
  assert.equal(shouldDecrementOnClose('Slot Locked', 'Closed Lost'), true);
});

test('Pending Approval close → NO decrement (the exact wave-2 drift-DOWN defect)', () => {
  // Pending Approval is pre-INCR — no slot was ever taken, so none may be
  // given back. Pre-fix ACTIVE_REF_STATES included it → counter went negative
  // relative to truth → matcher over-booked a genuinely-full rancher.
  assert.equal(shouldDecrementOnClose('Pending Approval', 'Closed Won'), false);
  assert.equal(shouldDecrementOnClose('Pending Approval', 'Closed Lost'), false);
});

test('terminal / empty / unknown previous statuses → NO decrement (repeat clicks are no-ops)', () => {
  // Closed Won → Closed Won (re-edit / double click), Closed Lost → Closed
  // Lost (repeated pass), Refunded, garbage, empty: none held a slot.
  for (const prev of ['Closed Won', 'Closed Lost', 'Refunded', 'Deposit Paid', 'Totally Bogus', '', null, undefined]) {
    assert.equal(shouldDecrementOnClose(prev, 'Closed Won'), false, `${String(prev)} → Closed Won must not decrement`);
    assert.equal(shouldDecrementOnClose(prev, 'Closed Lost'), false, `${String(prev)} → Closed Lost must not decrement`);
  }
});

test('held → held transition frees NOTHING (Awaiting Payment is canonically still held)', () => {
  // The 2026-05-20 dashboard model freed the slot on ENTERING Awaiting
  // Payment. Canon (HELD_REFERRAL_STATUSES) says AP still holds the slot —
  // the ground-truth reseed counts it — so an entry-DECR just drifts the
  // mirror DOWN until the real close. A held→held move must never DECR;
  // combined with held→terminal DECR above, each slot frees exactly once.
  for (const prev of HELD_REFERRAL_STATUSES) {
    for (const next of HELD_REFERRAL_STATUSES) {
      assert.equal(shouldDecrementOnClose(prev, next), false, `${prev} → ${next} must not decrement`);
    }
  }
});

test('same-status NOOP transitions never DECR, held or not', () => {
  for (const s of [...HELD_REFERRAL_STATUSES, 'Pending Approval', 'Closed Won', 'Closed Lost', 'Refunded', '']) {
    assert.equal(shouldDecrementOnClose(s, s), false, `${s} → ${s} must not decrement`);
  }
});

test('empty / unknown NEXT status → NO decrement (never free a slot on uncertainty)', () => {
  // Every real call site passes a validated concrete target status; if next
  // is missing something upstream broke — hold the slot, let the reseed heal.
  for (const next of ['', null, undefined]) {
    assert.equal(shouldDecrementOnClose('Negotiation', next), false, `Negotiation → ${String(next)} must not decrement`);
  }
});

test('close gate stays in lockstep with the canonical HELD_REFERRAL_STATUSES set', () => {
  for (const s of HELD_REFERRAL_STATUSES) {
    assert.equal(shouldDecrementOnClose(s, 'Closed Won'), true, `${s} is canonically held`);
    // Equivalence with the refund gate: closing to 'Refunded' and the refund
    // restore must make the identical decision for the identical prior status.
    assert.equal(shouldDecrementOnClose(s, 'Refunded'), shouldDecrementOnRefundRestore(s), `${s}: close-to-Refunded ≡ refund-restore`);
  }
});
