import { test } from 'node:test';
import assert from 'node:assert/strict';

// ──────────────────────────────────────────────────────────────────────────
// Regression locks for the rancher-cockpit money-UX fixes.
//
// The production logic lives inline in:
//   - app/api/rancher/dashboard/route.ts  (computeUnpaidCommission)
//   - app/rancher/page.tsx                (collectBalanceRefs / awaitingPaymentRefs)
//
// Those modules can't be imported into a node:test runner without pulling the
// whole Next/Airtable/auth env chain (lib/secrets.ts hard-requires ADMIN_PASSWORD
// et al at import time — see why every existing *.test.ts lives in lib/). So we
// mirror the EXACT predicates here as a behavioral spec. Keep these in lockstep
// with the source; they encode the money-path invariants the cockpit depends on.
// ──────────────────────────────────────────────────────────────────────────

type Row = Record<string, any>;

// Mirror of computeUnpaidCommission in dashboard/route.ts
function computeUnpaidCommission(closedWon: Row[], pricingModel: string): number {
  if (pricingModel === 'tier_v2') return 0;
  return closedWon
    .filter((r) => !r['Commission Paid'])
    .reduce((sum, r) => sum + (Number(r['Commission Due']) || 0), 0);
}

// Mirror of the collectBalanceRefs filter in page.tsx: deposit-paid + final
// balance unpaid + not Closed Lost. CRUCIALLY includes Closed Won so an
// already-closed deposit deal can never strand its uncollected balance.
function isCollectBalanceRow(r: Row): boolean {
  const depositPaid = !!r.deposit_paid_at && (r.deposit_amount || 0) > 0;
  const finalPaid = !!r.final_paid_at;
  const isDead = r.status === 'Closed Lost';
  return depositPaid && !finalPaid && !isDead;
}

// Mirror of the awaitingPaymentRefs filter in page.tsx: Awaiting Payment rows
// that are NOT deposit-paid (deposit-paid ones are handled by Collect Balance).
function isAwaitingPaymentRow(r: Row): boolean {
  return r.status === 'Awaiting Payment' && !(r.deposit_paid_at && (r.deposit_amount || 0) > 0);
}

// ─── Fix 2: phantom commission invoice ──────────────────────────────────────

const closedWon: Row[] = [
  { 'Commission Due': 100, 'Commission Paid': false },
  { 'Commission Due': 50, 'Commission Paid': true }, // already paid — excluded
  { 'Commission Due': 25, 'Commission Paid': false },
];

test('legacy: sums unpaid Commission Due across closed-won', () => {
  assert.equal(computeUnpaidCommission(closedWon, 'legacy'), 125);
});

test('tier_v2: always 0 — commission was taken at deposit, no post-close invoice', () => {
  assert.equal(computeUnpaidCommission(closedWon, 'tier_v2'), 0);
});

test('blank / unknown pricing model defaults to legacy behavior', () => {
  assert.equal(computeUnpaidCommission(closedWon, ''), 125);
  assert.equal(computeUnpaidCommission(closedWon, 'mystery'), 125);
});

test('missing / non-numeric Commission Due coerces to 0', () => {
  const rows: Row[] = [
    { 'Commission Paid': false },
    { 'Commission Due': null, 'Commission Paid': false },
    { 'Commission Due': 30, 'Commission Paid': false },
  ];
  assert.equal(computeUnpaidCommission(rows, 'legacy'), 30);
});

// ─── Fix 1: close-won must not strand a deposit balance ─────────────────────

test('deposit-paid, balance unpaid, NOT closed → in Collect Balance', () => {
  assert.equal(
    isCollectBalanceRow({ status: 'Awaiting Payment', deposit_paid_at: 't', deposit_amount: 500 }),
    true,
  );
});

test('deposit-paid Closed Won with unpaid balance is STILL collectable (no strand)', () => {
  assert.equal(
    isCollectBalanceRow({ status: 'Closed Won', deposit_paid_at: 't', deposit_amount: 500 }),
    true,
  );
});

test('final balance already paid → not in Collect Balance', () => {
  assert.equal(
    isCollectBalanceRow({ status: 'Closed Won', deposit_paid_at: 't', deposit_amount: 500, final_paid_at: 'x' }),
    false,
  );
});

test('Closed Lost is excluded from Collect Balance (deal is dead → refund flow)', () => {
  assert.equal(
    isCollectBalanceRow({ status: 'Closed Lost', deposit_paid_at: 't', deposit_amount: 500 }),
    false,
  );
});

test('no deposit → not in Collect Balance', () => {
  assert.equal(isCollectBalanceRow({ status: 'Negotiation' }), false);
  assert.equal(isCollectBalanceRow({ status: 'Awaiting Payment', deposit_amount: 500 }), false);
});

// ─── Fix 3: confirm-payment surface for Awaiting Payment ────────────────────

test('Awaiting Payment without a deposit surfaces in the confirm-payment list', () => {
  assert.equal(isAwaitingPaymentRow({ status: 'Awaiting Payment' }), true);
});

test('Awaiting Payment WITH a deposit is left to Collect Balance, not double-listed', () => {
  assert.equal(
    isAwaitingPaymentRow({ status: 'Awaiting Payment', deposit_paid_at: 't', deposit_amount: 200 }),
    false,
  );
});

test('non-Awaiting-Payment statuses never appear in the confirm-payment list', () => {
  for (const status of ['Intro Sent', 'Negotiation', 'Closed Won', 'Closed Lost']) {
    assert.equal(isAwaitingPaymentRow({ status }), false, `${status} must not be awaiting-payment`);
  }
});
