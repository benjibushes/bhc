// lib/commission.test.ts
//
// SLICE E (2026-07-01) — rail-split net-earnings truth.
//
// THE BUG: under tier_v2, BHC's commission is charged ON TOP of the rancher's
// price at deposit time (the buyer pays it) — the rancher keeps 100% of THEIR
// price. But every cockpit "net" surface computed net = revenue − commission
// (legacy semantics), understating tier_v2 earnings and directly contradicting
// the "you keep 100%" close-modal copy. netEarningsFor() is the ONE pure
// helper every display surface (dashboard route, earnings CSV, cockpit page)
// must route through.
//
// GUARDRAIL: legacy ranchers' numbers must be byte-identical — their
// semantics were always right (they pay the commission post-close).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  netEarningsFor,
  referralRail,
  normalizeCommissionRate,
  isCommissionRateFieldEmpty,
  hasLockedCommissionRate,
  getRancherCommissionRate,
  calcCommissionForRancher,
  partitionUnpaidByRail,
} from './commission';

test('referralRail: deposit paid → tier_v2 rail (net = full, nothing to invoice)', () => {
  assert.equal(referralRail({ 'Deposit Paid At': '2026-07-01T00:00:00Z' }), 'tier_v2');
  assert.equal(referralRail({ deposit_paid_at: '2026-07-01' }), 'tier_v2');
  assert.equal(referralRail({ depositPaidAt: '2026-07-01' }), 'tier_v2');
});

test('referralRail: no deposit paid → legacy rail, regardless of rancher tier', () => {
  // Migrated tier_v2 rancher, legacy invoice-collected row → legacy economics.
  assert.equal(referralRail({ 'Deposit Paid At': '', 'Stripe Invoice URL': 'https://x' }), 'legacy');
  // Off-rail tier_v2 close (call-closed, no deposit) → legacy, MUST be invoiced.
  assert.equal(referralRail({ 'Commission Due': 100 }), 'legacy');
  assert.equal(referralRail({ 'Deposit Paid At': '   ' }), 'legacy'); // whitespace
  assert.equal(referralRail({}), 'legacy');
  assert.equal(referralRail(null), 'legacy');
});

test('referralRail feeds netEarningsFor: deposit row keeps 100%, off-rail nets out', () => {
  const depositRow = { 'Deposit Paid At': '2026-07-01', 'Sale Amount': 1000, 'Commission Due': 100 };
  const offRailRow = { 'Sale Amount': 1000, 'Commission Due': 100 };
  assert.equal(netEarningsFor(referralRail(depositRow), 1000, 100), 1000);
  assert.equal(netEarningsFor(referralRail(offRailRow), 1000, 100), 900);
});

test('netEarningsFor: tier_v2 net = revenue (commission was the buyer add-on)', () => {
  assert.equal(netEarningsFor('tier_v2', 2000, 200), 2000);
  assert.equal(netEarningsFor('tier_v2', 0, 500), 0);
  // Even a huge commission never dents a tier_v2 rancher's net.
  assert.equal(netEarningsFor('tier_v2', 1500, 1500), 1500);
});

test('netEarningsFor: legacy net = revenue − commission (byte-identical to old math)', () => {
  assert.equal(netEarningsFor('legacy', 2000, 200), 2000 - 200);
  assert.equal(netEarningsFor('legacy', 1500, 150), 1350);
  assert.equal(netEarningsFor('legacy', 0, 0), 0);
});

test('netEarningsFor: unknown/blank rail falls back to legacy semantics', () => {
  // Anything that is not tier_v2 keeps the deduct-commission math so legacy
  // ranchers (and malformed Pricing Model values) never inflate.
  assert.equal(netEarningsFor('', 2000, 200), 1800);
  assert.equal(netEarningsFor(null, 2000, 200), 1800);
  assert.equal(netEarningsFor(undefined, 2000, 200), 1800);
  assert.equal(netEarningsFor('something_else', 2000, 200), 1800);
});

test('netEarningsFor: rail matching tolerates case + whitespace', () => {
  // Airtable singleSelect values pass through String() coercions in several
  // routes — be liberal in what the display helper accepts.
  assert.equal(netEarningsFor('TIER_V2', 2000, 200), 2000);
  assert.equal(netEarningsFor(' tier_v2 ', 2000, 200), 2000);
});

test('netEarningsFor: non-numeric inputs coerce to 0, never NaN', () => {
  assert.equal(netEarningsFor('legacy', Number('x'), 200), -200);
  assert.equal(netEarningsFor('legacy', 2000, Number('x')), 2000);
  assert.equal(netEarningsFor('tier_v2', Number('x'), Number('x')), 0);
});

// ─── MONEY-TRUTH TAIL (2026-07-01) — commission-rate normalization ──────────
//
// THE BUG TRIO:
//   (b) hasLockedCommissionRate treated 0 as "no rate" → every Operator-tier
//       (0% commission) close hit the HARD GATE, or — worse — the rate read
//       fell back to the 10% env default and billed a zero-commission rancher.
//   (c) No normalization on the Airtable field: 'Commission Rate' = 4 (a human
//       typed "4" meaning 4%) passed the old `raw > 0` check and clamped to 1
//       → billed 100% of the sale instead of 4%.
//
// normalizeCommissionRate is the ONE pure decision. Decision table:
//   null / undefined / ''            → null   (unset — no-rate gate fires)
//   non-numeric garbage ('abc')      → null
//   negative                         → null   (never a valid rate)
//   0                                → 0      (VALID — Operator tier)
//   0 < raw < 1                      → raw    (already a fraction)
//   1 ≤ raw < 100                    → raw/100 (typed as percent; 1 → 0.01 —
//                                      no BHC rate is 100%, a literal 1 is a
//                                      typo for 1%)
//   raw ≥ 100 (fraction would be ≥1) → null   (implausible as fraction OR
//                                      percent — gate, don't guess)

test('normalizeCommissionRate: fractions ≤ real-world range pass through', () => {
  assert.equal(normalizeCommissionRate(0.04), 0.04);
  assert.equal(normalizeCommissionRate(0.10), 0.10);
  assert.equal(normalizeCommissionRate(0.03), 0.03);
  assert.equal(normalizeCommissionRate(0.99), 0.99);
});

test('normalizeCommissionRate: 0 is a VALID rate (Operator tier), not unset', () => {
  assert.equal(normalizeCommissionRate(0), 0);
});

test('normalizeCommissionRate: percent-typed values divide by 100', () => {
  assert.equal(normalizeCommissionRate(4), 0.04);
  assert.equal(normalizeCommissionRate(10), 0.10);
  assert.equal(normalizeCommissionRate(7), 0.07);
  assert.equal(normalizeCommissionRate(1.5), 0.015);
});

test('normalizeCommissionRate: boundary 1 → 0.01 (1%, never 100%)', () => {
  assert.equal(normalizeCommissionRate(1), 0.01);
});

test('normalizeCommissionRate: unset / garbage / implausible → null', () => {
  assert.equal(normalizeCommissionRate(null), null);
  assert.equal(normalizeCommissionRate(undefined), null);
  assert.equal(normalizeCommissionRate(''), null);
  assert.equal(normalizeCommissionRate('abc'), null);
  assert.equal(normalizeCommissionRate(NaN), null);
  assert.equal(normalizeCommissionRate(Infinity), null);
  assert.equal(normalizeCommissionRate(-0.05), null);
  assert.equal(normalizeCommissionRate(-4), null);
  // ≥ 100 can't be a percent (would be ≥ 100%) nor a fraction — gate it.
  assert.equal(normalizeCommissionRate(100), null);
  assert.equal(normalizeCommissionRate(400), null);
});

test('normalizeCommissionRate: numeric strings tolerated (Airtable coercions)', () => {
  assert.equal(normalizeCommissionRate('0.04'), 0.04);
  assert.equal(normalizeCommissionRate('4'), 0.04);
  assert.equal(normalizeCommissionRate('4%'), 0.04);
  assert.equal(normalizeCommissionRate(' 10 '), 0.10);
  assert.equal(normalizeCommissionRate('0'), 0);
});

test('hasLockedCommissionRate: 0 IS a locked rate (Operator close must not gate)', () => {
  assert.equal(hasLockedCommissionRate({ 'Commission Rate': 0 }), true);
});

test('hasLockedCommissionRate: real fractions and percent-typed values count as locked', () => {
  assert.equal(hasLockedCommissionRate({ 'Commission Rate': 0.04 }), true);
  assert.equal(hasLockedCommissionRate({ 'Commission Rate': 4 }), true);
});

test('hasLockedCommissionRate: unset / garbage / implausible do NOT count', () => {
  assert.equal(hasLockedCommissionRate({}), false);
  assert.equal(hasLockedCommissionRate(null), false);
  assert.equal(hasLockedCommissionRate({ 'Commission Rate': null }), false);
  assert.equal(hasLockedCommissionRate({ 'Commission Rate': '' }), false);
  assert.equal(hasLockedCommissionRate({ 'Commission Rate': 'abc' }), false);
  assert.equal(hasLockedCommissionRate({ 'Commission Rate': 400 }), false);
});

test('getRancherCommissionRate: locked 0 returns 0 — never the 10% env default', () => {
  assert.equal(getRancherCommissionRate({ 'Commission Rate': 0 }), 0);
});

test('getRancherCommissionRate: percent-typed 4 bills 4%, not 100%', () => {
  assert.equal(getRancherCommissionRate({ 'Commission Rate': 4 }), 0.04);
  // The whole point: a $1,500 sale at "4" must be $60, not $1,500.
  assert.equal(calcCommissionForRancher({ 'Commission Rate': 4 }, 1500), 60);
});

test('getRancherCommissionRate: locked fraction passes through untouched', () => {
  assert.equal(getRancherCommissionRate({ 'Commission Rate': 0.08 }), 0.08);
  assert.equal(calcCommissionForRancher({ 'Commission Rate': 0.08 }, 1500), 120);
});

test('getRancherCommissionRate: Operator-tier zero rate bills $0 commission', () => {
  assert.equal(calcCommissionForRancher({ 'Commission Rate': 0 }, 5000), 0);
});

test('getRancherCommissionRate: unset/garbage falls back to the env default', () => {
  // env default (no NEXT_PUBLIC_COMMISSION_RATE in test env) = 0.10
  assert.equal(getRancherCommissionRate({}), 0.10);
  assert.equal(getRancherCommissionRate({ 'Commission Rate': 'abc' }), 0.10);
  assert.equal(getRancherCommissionRate(null), 0.10);
});

// ─── Upsert-skip predicate (finding 1a) ─────────────────────────────────────
// The tier-subscription webhook may stamp the tier's default Commission Rate
// ONLY onto a rancher row whose field is truly EMPTY. A non-empty value — even
// garbage — is operator-owned (a negotiated/locked rate, or a typo the close
// gate will surface); the webhook must NEVER overwrite it.

test('isCommissionRateFieldEmpty: null / undefined / blank string are empty', () => {
  assert.equal(isCommissionRateFieldEmpty(null), true);
  assert.equal(isCommissionRateFieldEmpty(undefined), true);
  assert.equal(isCommissionRateFieldEmpty(''), true);
  assert.equal(isCommissionRateFieldEmpty('   '), true);
});

test('isCommissionRateFieldEmpty: 0 is NOT empty (Ashcraft-class negotiated 0%)', () => {
  assert.equal(isCommissionRateFieldEmpty(0), false);
});

test('isCommissionRateFieldEmpty: any locked number is NOT empty', () => {
  assert.equal(isCommissionRateFieldEmpty(0.04), false);
  assert.equal(isCommissionRateFieldEmpty(4), false);
});

test('isCommissionRateFieldEmpty: garbage is NOT empty (operator-owned — never clobber)', () => {
  assert.equal(isCommissionRateFieldEmpty('abc'), false);
  assert.equal(isCommissionRateFieldEmpty(400), false);
});

// ─── Monthly-cron rail partition (RAIL-PER-ROW, 2026-07-15) ─────────────────
// The commission-invoices cron used to decide per-RANCHER: tier_v2 → skip
// invoicing AND stamp Commission Paid=true on EVERY unpaid Closed Won row.
// An off-rail close (no deposit ever paid) by a tier_v2 rancher was thereby
// stamped "paid" without a cent collected — the receivable was destroyed.
// partitionUnpaidByRail splits rows by what THIS row actually did:
//   depositRail     → commission skimmed at deposit; safe to stamp paid.
//   invoiceEligible → legacy economics; MUST flow into the monthly invoice.

test('partitionUnpaidByRail: deposit-paid rows → depositRail, everything else invoiceEligible', () => {
  const paid = { id: 'r1', 'Deposit Paid At': '2026-07-01T00:00:00Z' };
  const offRail = { id: 'r2', 'Commission Due': 156.91 }; // Foodstead class
  const legacy = { id: 'r3', 'Deposit Paid At': '' };
  const { depositRail, invoiceEligible } = partitionUnpaidByRail([paid, offRail, legacy]);
  assert.deepEqual(depositRail.map((r: any) => r.id), ['r1']);
  assert.deepEqual(invoiceEligible.map((r: any) => r.id), ['r2', 'r3']);
});

test('partitionUnpaidByRail: whitespace Deposit Paid At is NOT a deposit', () => {
  const { depositRail, invoiceEligible } = partitionUnpaidByRail([
    { id: 'r1', 'Deposit Paid At': '   ' },
  ]);
  assert.equal(depositRail.length, 0);
  assert.equal(invoiceEligible.length, 1);
});

test('partitionUnpaidByRail: empty input → both partitions empty', () => {
  const { depositRail, invoiceEligible } = partitionUnpaidByRail([]);
  assert.deepEqual(depositRail, []);
  assert.deepEqual(invoiceEligible, []);
});
