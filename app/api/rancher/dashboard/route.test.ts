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

// Mirror of referralRail + computeUnpaidCommission in dashboard/route.ts
// (RAIL-PER-ROW, audit fix #4): a row rode the deposit rail — owes nothing —
// only when 'Deposit Paid At' is stamped; every other Closed Won row (legacy
// invoice OR off-rail tier_v2 close) owes commission until paid.
function referralRail(r: Row): 'tier_v2' | 'legacy' {
  const dp = r['Deposit Paid At'] ?? r.deposit_paid_at ?? '';
  return String(dp || '').trim() ? 'tier_v2' : 'legacy';
}
function computeUnpaidCommission(closedWon: Row[]): number {
  return closedWon
    .filter((r) => referralRail(r) === 'legacy' && !r['Commission Paid'])
    .reduce((sum, r) => sum + (Number(r['Commission Due']) || 0), 0);
}

// Mirror of referralFeeDollars in dashboard/route.ts (Wave 1A, 2026-08-01):
// the fee a row ACTUALLY carried. 'BHC Fee Cents' (buyer-paid Connect fee,
// stamped at deposit settle) wins when a real fee was captured; the legacy
// 'Commission Due' receivable is the fallback — including on a written 0
// ("no fee captured"), so a legacy row can never be masked to $0.
function referralFeeDollars(r: Row): number {
  const feeCents = Number(r['BHC Fee Cents']);
  if (Number.isFinite(feeCents) && feeCents > 0) return Math.round(feeCents) / 100;
  return Number(r['Commission Due']) || 0;
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

test('legacy rows (no deposit paid): sums unpaid Commission Due across closed-won', () => {
  assert.equal(computeUnpaidCommission(closedWon), 125);
});

test('rail-per-row: a deposit-paid row owes nothing; an off-rail row still owes', () => {
  const mixed: Row[] = [
    // Rode the deposit rail — commission taken at deposit, owes nothing.
    { 'Commission Due': 200, 'Commission Paid': false, 'Deposit Paid At': '2026-07-01T00:00:00Z' },
    // Off-rail close (no deposit) — still owes, previously leaked as $0.
    { 'Commission Due': 90, 'Commission Paid': false },
    // Legacy invoice already paid — excluded.
    { 'Commission Due': 40, 'Commission Paid': true },
  ];
  assert.equal(computeUnpaidCommission(mixed), 90);
});

test('missing / non-numeric Commission Due coerces to 0', () => {
  const rows: Row[] = [
    { 'Commission Paid': false },
    { 'Commission Due': null, 'Commission Paid': false },
    { 'Commission Due': 30, 'Commission Paid': false },
  ];
  assert.equal(computeUnpaidCommission(rows), 30);
});

// ─── Wave 1A: Connect fee visibility (referralFeeDollars) ───────────────────
// The "Commission $0" bug: Connect rows never carry 'Commission Due' (that
// receivable is legacy-rail only), so the Earnings totals summed to $0 under
// the "buyers paid this on top" sub-copy. The stamped 'BHC Fee Cents' is the
// real number.

test('Connect row: BHC Fee Cents (cents) wins over the always-$0 Commission Due', () => {
  assert.equal(
    referralFeeDollars({ 'BHC Fee Cents': 29990, 'Commission Due': 0, 'Deposit Paid At': 't' }),
    299.9,
  );
});

test('legacy row (no fee stamp): falls back to Commission Due', () => {
  assert.equal(referralFeeDollars({ 'Commission Due': 150 }), 150);
});

test('written 0 fee ("no fee captured") falls through — a legacy receivable is never masked to $0', () => {
  assert.equal(referralFeeDollars({ 'BHC Fee Cents': 0, 'Commission Due': 150 }), 150);
});

test('garbage / missing values coerce to 0, never NaN on a money surface', () => {
  assert.equal(referralFeeDollars({}), 0);
  assert.equal(referralFeeDollars({ 'BHC Fee Cents': 'abc', 'Commission Due': null }), 0);
});

test('totalCommission with per-row preference: mixed Connect + legacy history sums both rails', () => {
  const rows: Row[] = [
    // Connect close — fee captured at deposit, Commission Due never written.
    { 'BHC Fee Cents': 29990, 'Commission Due': 0, 'Deposit Paid At': 't' },
    // Legacy close — invoice receivable only.
    { 'Commission Due': 150 },
  ];
  const total = rows.reduce((sum, r) => sum + referralFeeDollars(r), 0);
  assert.equal(total, 449.9);
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
