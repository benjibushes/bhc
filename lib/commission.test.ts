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
  shouldWriteLegacyCommissionDue,
  isBrokerReferralRow,
  isPostCloseInvoiceRail,
  brokerFeeDollars,
  referralNetDollars,
  netsFullSaleOnEveryClosedWon,
} from './commission';
import { BROKER_MATCH_TYPE } from './brokerRail';

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

// ── shouldWriteLegacyCommissionDue (money-model truth, 2026-07-24) ───────────
//
// THE BUG: app/api/referrals/[id] PATCH wrote `Commission Due` on ANY close
// carrying a Sale Amount, never checking the rail. Close a Connect deal from
// /admin and the founder sees a receivable Stripe already collected at deposit,
// while the rancher dashboard (which DOES filter on rail) shows it settled.

test('shouldWriteLegacyCommissionDue: legacy close (no deposit) → write the receivable', () => {
  assert.equal(shouldWriteLegacyCommissionDue({ Status: 'Closed Won' }), true);
  assert.equal(shouldWriteLegacyCommissionDue({ 'Deposit Paid At': '' }), true);
  assert.equal(shouldWriteLegacyCommissionDue({ 'Deposit Paid At': null }), true);
  assert.equal(shouldWriteLegacyCommissionDue({ 'Deposit Paid At': '   ' }), true);
});

test('shouldWriteLegacyCommissionDue: Connect close (deposit paid) → never write', () => {
  assert.equal(shouldWriteLegacyCommissionDue({ 'Deposit Paid At': '2026-07-19T03:31:00.631Z' }), false);
  assert.equal(shouldWriteLegacyCommissionDue({ deposit_paid_at: '2026-07-19' }), false);
  assert.equal(shouldWriteLegacyCommissionDue({ depositPaidAt: '2026-07-19' }), false);
});

test('shouldWriteLegacyCommissionDue: unknown referral (read failed) FAILS OPEN', () => {
  // null ≠ "on Connect". Skipping the write here would silently destroy a real
  // legacy receivable; writing it can only over-state a tile, because the
  // monthly invoice cron re-checks the rail via partitionUnpaidByRail.
  assert.equal(shouldWriteLegacyCommissionDue(null), true);
  assert.equal(shouldWriteLegacyCommissionDue(undefined), true);
});

test('shouldWriteLegacyCommissionDue agrees with partitionUnpaidByRail row-for-row', () => {
  const rows = [
    { id: 'a' },
    { id: 'b', 'Deposit Paid At': '2026-07-19T00:00:00Z' },
    { id: 'c', 'Deposit Paid At': '' },
    { id: 'd', deposit_paid_at: '2026-07-01' },
  ];
  const { depositRail, invoiceEligible } = partitionUnpaidByRail(rows);
  assert.deepEqual(
    invoiceEligible.map((r) => r.id),
    rows.filter(shouldWriteLegacyCommissionDue).map((r) => r.id),
  );
  assert.deepEqual(
    depositRail.map((r) => r.id),
    rows.filter((r) => !shouldWriteLegacyCommissionDue(r)).map((r) => r.id),
  );
});


// ═══════════════════════════════════════════════════════════════════════════
// RAIL-MATRIX (2026-08-04) — cross-rail adversarial pins.
//
// Boundary B of the rail matrix: a commission INVOICE may only ever exist on
// the legacy lead-send rail. The Connect rail's fee was buyer-paid at deposit
// (invoicing = double-charge) and the BROKER rail's fee IS the deposit BHC
// kept (invoicing = charging a model the represented rancher never signed).
// These tests construct the data-error rows a human could realistically
// produce and pin the refusal.
// ═══════════════════════════════════════════════════════════════════════════

// ── isBrokerReferralRow ─────────────────────────────────────────────────────

test('isBrokerReferralRow: exact Match Type match, raw / shaped / {name} object forms', () => {
  assert.equal(isBrokerReferralRow({ 'Match Type': BROKER_MATCH_TYPE }), true);
  assert.equal(isBrokerReferralRow({ 'Match Type': `  ${BROKER_MATCH_TYPE}  ` }), true);
  assert.equal(isBrokerReferralRow({ match_type: BROKER_MATCH_TYPE }), true);
  assert.equal(isBrokerReferralRow({ 'Match Type': { name: BROKER_MATCH_TYPE } }), true);
});

test('isBrokerReferralRow: everything else is NOT broker (fail closed toward normal rails)', () => {
  assert.equal(isBrokerReferralRow({ 'Match Type': 'Direct (Rancher Page) — Deposit' }), false);
  assert.equal(isBrokerReferralRow({ 'Match Type': 'Manual' }), false);
  assert.equal(isBrokerReferralRow({ 'Match Type': '' }), false);
  assert.equal(isBrokerReferralRow({}), false);
  assert.equal(isBrokerReferralRow(null), false);
  assert.equal(isBrokerReferralRow(undefined), false);
});

// ── isPostCloseInvoiceRail — the ONE question every close-time invoice asks ──

test('isPostCloseInvoiceRail: legacy off-rail row → invoiceable', () => {
  assert.equal(isPostCloseInvoiceRail({ 'Status': 'Closed Won', 'Commission Due': 120 }), true);
});

test('isPostCloseInvoiceRail: Connect deposit-paid row → NEVER (fee was buyer-paid at deposit)', () => {
  assert.equal(
    isPostCloseInvoiceRail({ 'Deposit Paid At': '2026-08-01T00:00:00Z', 'Commission Due': 120 }),
    false,
  );
});

test('isPostCloseInvoiceRail: broker row → NEVER, deposit paid or not', () => {
  // Paid broker close — Deposit Paid At + Match Type both stamped at settle.
  assert.equal(
    isPostCloseInvoiceRail({
      'Match Type': BROKER_MATCH_TYPE,
      'Deposit Paid At': '2026-08-01T00:00:00Z',
    }),
    false,
  );
  // THE HOLE THIS PINS: buyer never paid the broker link, the deal closed at
  // the ranch anyway, and a hand-close wrote Sale Amount + Commission Due.
  // Without the Match Type belt this row read 'legacy' and fired an invoice
  // at a represented rancher.
  assert.equal(
    isPostCloseInvoiceRail({
      'Match Type': BROKER_MATCH_TYPE,
      'Status': 'Closed Won',
      'Sale Amount': 1800,
      'Commission Due': 180,
    }),
    false,
  );
});

// ── partitionUnpaidByRail — broker bucket ───────────────────────────────────

test('partitionUnpaidByRail: PAID broker row → depositRail (fee captured at settle; stamp is true)', () => {
  const { depositRail, brokerUnpaid, invoiceEligible } = partitionUnpaidByRail([
    { id: 'b1', 'Match Type': BROKER_MATCH_TYPE, 'Deposit Paid At': '2026-08-01T00:00:00Z' },
  ]);
  assert.deepEqual(depositRail.map((r: any) => r.id), ['b1']);
  assert.deepEqual(brokerUnpaid, []);
  assert.deepEqual(invoiceEligible, []);
});

test('partitionUnpaidByRail: UNPAID broker Closed Won with a phantom Commission Due → brokerUnpaid, never invoiceEligible', () => {
  const { depositRail, brokerUnpaid, invoiceEligible } = partitionUnpaidByRail([
    {
      id: 'b2',
      'Match Type': BROKER_MATCH_TYPE,
      'Status': 'Closed Won',
      'Sale Amount': 1800,
      'Commission Due': 180, // data error — a hand-close wrote the receivable
    },
  ]);
  assert.deepEqual(brokerUnpaid.map((r: any) => r.id), ['b2']);
  assert.deepEqual(depositRail, []);
  assert.deepEqual(invoiceEligible, []);
});

test('partitionUnpaidByRail: Connect row with a phantom Commission Due (data error) stays depositRail', () => {
  // Adversarial: someone typed a Commission Due onto a Connect deal whose fee
  // was already buyer-paid at deposit. The nonzero receivable must not drag it
  // into the invoice run — Deposit Paid At wins.
  const { depositRail, invoiceEligible } = partitionUnpaidByRail([
    { id: 'c1', 'Deposit Paid At': '2026-08-01T00:00:00Z', 'Commission Due': 299.9 },
  ]);
  assert.deepEqual(depositRail.map((r: any) => r.id), ['c1']);
  assert.deepEqual(invoiceEligible, []);
});

// ── RAIL-PER-ROW under migration (#356) — the rancher's CURRENT model is ────
// irrelevant; the row settles under the rail it was OPENED on.

test('mid-migration pin: rows carry their own rail — rancher Pricing Model junk on the row is ignored', () => {
  // A legacy rancher mid-migration to tier_v2: the OLD open deal (no deposit
  // ever paid) still owes the post-close invoice even though the rancher is
  // now tier_v2 — and a deposit-paid row stays skimmed even if the rancher is
  // flipped BACK to legacy. Neither helper may consult a Pricing Model field.
  const legacyOpened = { id: 'old', 'Pricing Model': 'tier_v2', 'Commission Due': 150 };
  const connectOpened = { id: 'new', 'Pricing Model': 'legacy', 'Deposit Paid At': '2026-08-01T00:00:00Z' };
  const { depositRail, invoiceEligible } = partitionUnpaidByRail([legacyOpened, connectOpened]);
  assert.deepEqual(invoiceEligible.map((r: any) => r.id), ['old']);
  assert.deepEqual(depositRail.map((r: any) => r.id), ['new']);
  assert.equal(isPostCloseInvoiceRail(legacyOpened), true);
  assert.equal(isPostCloseInvoiceRail(connectOpened), false);
});

// ── shouldWriteLegacyCommissionDue — broker belt ────────────────────────────

test('shouldWriteLegacyCommissionDue: broker row → never write, paid or not (null still fails open)', () => {
  assert.equal(shouldWriteLegacyCommissionDue({ 'Match Type': BROKER_MATCH_TYPE }), false);
  assert.equal(
    shouldWriteLegacyCommissionDue({
      'Match Type': BROKER_MATCH_TYPE,
      'Deposit Paid At': '2026-08-01T00:00:00Z',
    }),
    false,
  );
  // The fail-open contract for an unreadable referral is untouched.
  assert.equal(shouldWriteLegacyCommissionDue(null), true);
});

// ── broker net-earnings truth (rancher dashboard, boundary C) ───────────────

test('broker row net: sale − the deposit BHC kept, via netEarningsFor non-tier_v2 branch', () => {
  // A migrated ex-represented rancher's dashboard: the broker-era row has
  // Deposit Paid At (reads tier_v2 → net = full sale = WRONG, overstated by
  // the whole deposit). The dashboard now routes broker rows through the
  // rev − fee branch with the BHC Fee Cents stamp as the fee.
  const sale = 1800;
  const feeDollars = 400; // BHC Fee Cents 40000 — the whole deposit
  assert.equal(netEarningsFor('broker', sale, feeDollars), 1400); // price − deposit
});

// ── brokerFeeDollars: the fee a BROKER row actually carried ─────────────────

test('brokerFeeDollars: paid row → the BHC Fee Cents stamp (the whole deposit), in dollars', () => {
  assert.equal(brokerFeeDollars({ 'BHC Fee Cents': 50000, 'Deposit Paid At': 't', 'Deposit Amount': 500 }), 500);
  // shaped dashboard read
  assert.equal(brokerFeeDollars({ bhc_fee_cents: 50000, deposit_paid_at: 't' }), 500);
  // camelCase (EarningsRow)
  assert.equal(brokerFeeDollars({ bhcFeeCents: 50000, depositPaidAt: 't' }), 500);
});

test('brokerFeeDollars: paid row missing the fee stamp falls back to Deposit Amount (on this rail the deposit IS the fee)', () => {
  assert.equal(brokerFeeDollars({ 'Deposit Paid At': '2026-08-10T00:00:00Z', 'Deposit Amount': 450 }), 450);
  assert.equal(brokerFeeDollars({ deposit_paid_at: 't', deposit_amount: 450 }), 450);
  assert.equal(brokerFeeDollars({ depositPaidAt: 't', depositAmount: 450 }), 450);
});

test('brokerFeeDollars: UNPAID row → 0, NEVER the phantom Commission Due (nothing was collected; never invoiced)', () => {
  assert.equal(brokerFeeDollars({ 'Commission Due': 300 }), 0);
  assert.equal(brokerFeeDollars({ 'Commission Due': 300, 'Deposit Amount': 500 }), 0); // amount without a paid stamp is not a fee
  assert.equal(brokerFeeDollars({}), 0);
  assert.equal(brokerFeeDollars({ 'BHC Fee Cents': 'abc' }), 0);
});

// ── referralNetDollars: THE per-row net every rancher money surface reads ───

test('referralNetDollars: PAID broker row nets sale − the deposit BHC kept (not the full sale)', () => {
  const r = {
    'Match Type': BROKER_MATCH_TYPE,
    'Sale Amount': 3000,
    'Deposit Paid At': 't',
    'Deposit Amount': 500,
    'BHC Fee Cents': 50000,
    'Commission Due': 0,
  };
  assert.equal(referralNetDollars(r), 2500);
});

test('referralNetDollars: UNPAID hand-closed broker row nets the FULL sale — phantom Commission Due ignored', () => {
  const r = { 'Match Type': BROKER_MATCH_TYPE, 'Sale Amount': 3000, 'Commission Due': 300 };
  assert.equal(referralNetDollars(r), 3000);
});

test('referralNetDollars: tier_v2 deposit row keeps 100% (byte-identical to the old branch)', () => {
  assert.equal(referralNetDollars({ 'Sale Amount': 2000, 'Commission Due': 0, 'Deposit Paid At': 't' }), 2000);
});

test('referralNetDollars: legacy/off-rail row nets out the commission (byte-identical to the old branch)', () => {
  assert.equal(referralNetDollars({ 'Sale Amount': 2000, 'Commission Due': 200 }), 1800);
});

test('referralNetDollars: shaped dashboard rows (sale_amount/commission_due/match_type) work identically', () => {
  assert.equal(
    referralNetDollars({ match_type: BROKER_MATCH_TYPE, sale_amount: 3000, deposit_paid_at: 't', bhc_fee_cents: 50000 }),
    2500,
  );
  assert.equal(referralNetDollars({ sale_amount: 2000, commission_due: 200 }), 1800);
});

// ── netsFullSaleOnEveryClosedWon: the "You keep 100%" banner predicate ──────

test('banner predicate: pure-Connect history (every close deposit-railed) → banner claim TRUE', () => {
  const rows = [
    { 'Sale Amount': 2000, 'Commission Due': 0, 'Deposit Paid At': 't' },
    { sale_amount: 1500, commission_due: 0, deposit_paid_at: 't' },
  ];
  assert.equal(netsFullSaleOnEveryClosedWon(rows), true);
});

test('banner predicate: a legacy-netted close present → banner claim FALSE (suppress/qualify)', () => {
  // The live example: revenue 6687.23 vs net 6318.40 on the same screen as
  // "Commission Owed $0" — one off-rail close netted as legacy.
  const rows = [
    { 'Sale Amount': 2998.93, 'Commission Due': 0, 'Deposit Paid At': 't' },
    { 'Sale Amount': 3688.3, 'Commission Due': 368.83 }, // off-rail: nets below sale
  ];
  assert.equal(netsFullSaleOnEveryClosedWon(rows), false);
});

test('banner predicate: a PAID broker-era close also falsifies "you keep 100%" (deposit came out of the price)', () => {
  const rows = [
    { 'Sale Amount': 2000, 'Commission Due': 0, 'Deposit Paid At': 't' },
    { 'Match Type': BROKER_MATCH_TYPE, 'Sale Amount': 3000, 'Deposit Paid At': 't', 'BHC Fee Cents': 50000 },
  ];
  assert.equal(netsFullSaleOnEveryClosedWon(rows), false);
});

test('banner predicate: an off-rail close with a $0 commission does not contradict the claim', () => {
  const rows = [{ 'Sale Amount': 2000, 'Commission Due': 0 }];
  assert.equal(netsFullSaleOnEveryClosedWon(rows), true);
});

test('banner predicate: no closed-won rows yet → claim stands (new Connect rancher sees the promise)', () => {
  assert.equal(netsFullSaleOnEveryClosedWon([]), true);
});
