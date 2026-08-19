// lib/bhcRevenue.test.ts — ONE rail-complete definition of "what BHC earned".
//
// THE DEFECT (2026-08-19). The founder's two money screens disagreed, and the
// primary one omitted most of the money:
//
//   • /admin/today "Earned" = Connect fee + shop margin. The LEGACY invoiced
//     commission was absent BY CONSTRUCTION — and legacy is ~84% of lifetime
//     revenue ($3,350.80 of $3,982.57 on the live base the day this shipped).
//     Month-to-date read $178.72 when the truth was $273.13.
//   • /admin's command-center totalled a third rail set with a fourth label,
//     and computed deposits outstanding from an un-deduped `pending ||
//     abandoned` reduce: $3,750 against /admin/today's corrected $500. Same
//     base, 7.5x apart, no label on either explaining the difference.
//
// Both screens now read this module, and every figure carries the rail list it
// covers so a partial can never be mistaken for a total.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REVENUE_RAILS,
  UNMEASURED_REVENUE_RAILS,
  computeBhcRevenue,
  type RevenueSnapshot,
} from './bhcRevenue';
import {
  computeConnectFeeCaptured,
  computeProductMargin,
  computeProductMarginInRange,
} from './commissionStats';

const ALWAYS = () => true;

/** A Connect deposit that settled: fee charged on top, kept by BHC. */
const connectPayment = (over: Record<string, unknown> = {}) => ({
  'Status': 'succeeded',
  'Amount Cents': 65000,
  'Platform Fee Cents': 15315,
  'Captured At': '2026-08-11T00:01:48.110Z',
  ...over,
});

/** A broker deposit: 'Platform Fee Cents' === 'Amount Cents' ON PURPOSE. */
const brokerPayment = (over: Record<string, unknown> = {}) => ({
  'Type': 'broker_deposit',
  'Status': 'succeeded',
  'Amount Cents': 20000,
  'Platform Fee Cents': 20000,
  'Captured At': '2026-08-12T00:00:00.000Z',
  ...over,
});

const shopOrder = (over: Record<string, unknown> = {}) => ({
  'Status': 'Shipped',
  'Buyer Paid': 375,
  'BHC Margin': 45.07,
  'Ordered At': '2026-08-01T20:08:03.780Z',
  ...over,
});

/** A LEGACY Closed Won referral — no deposit, commission invoiced after close. */
const legacyClose = (over: Record<string, unknown> = {}) => ({
  'Status': 'Closed Won',
  'Commission Due': 207,
  'Commission Paid': true,
  'Match Type': 'Local',
  'Closed At': '2026-08-10T22:19:53.482Z',
  ...over,
});

const founder = (over: Record<string, unknown> = {}) => ({
  'Founder Tier': 'Founding 100',
  'Tier Amount Paid': 1000,
  'Subscribed At': '2026-08-05T00:00:00.000Z',
  ...over,
});

const brand = (over: Record<string, unknown> = {}) => ({
  'Tier': 'Spotlight',
  'Amount Paid': 295,
  'Payment Status': 'Paid',
  'Paid At': '2026-08-06T00:00:00.000Z',
  ...over,
});

const snapshot = (over: Partial<RevenueSnapshot> = {}): RevenueSnapshot => ({
  payments: [],
  rancherOrders: [],
  referrals: [],
  consumers: [],
  brands: [],
  ...over,
});

// ── the rail list is the contract ──────────────────────────────────────────

test('REVENUE_RAILS names every rail that earns, and nothing else', () => {
  assert.deepEqual(REVENUE_RAILS, [
    'connectFee',
    'brokerDeposit',
    'shopMargin',
    'legacyCommission',
    'founders',
    'brandPartner',
  ]);
});

test('every rail in the list appears in the breakdown, even at zero', () => {
  const r = computeBhcRevenue(snapshot(), ALWAYS);
  for (const rail of REVENUE_RAILS) {
    assert.equal(typeof r.byRail[rail], 'number', `${rail} missing from the breakdown`);
  }
  assert.equal(r.total, 0);
});

test('UNMEASURED_REVENUE_RAILS is non-empty and documents what the total omits', () => {
  // Rancher SaaS tiers, add-ons, founder/brand RENEWALS, gear affiliate and
  // merch all take money in Stripe with no amount persisted in Airtable. The
  // total is honest only if the screens can say what it leaves out.
  assert.ok(UNMEASURED_REVENUE_RAILS.length > 0);
  for (const rail of UNMEASURED_REVENUE_RAILS) {
    assert.ok(rail.rail && rail.why, 'each unmeasured rail states why it cannot be counted');
  }
});

// ── the total spans every rail ─────────────────────────────────────────────

test('THE FIX: the total includes the LEGACY rail, not just the current ones', () => {
  const r = computeBhcRevenue(
    snapshot({
      payments: [connectPayment()],
      rancherOrders: [shopOrder()],
      referrals: [legacyClose()],
    }),
    ALWAYS,
  );
  assert.equal(r.byRail.connectFee, 153.15);
  assert.equal(r.byRail.shopMargin, 45.07);
  assert.equal(r.byRail.legacyCommission, 207);
  assert.equal(r.total, 405.22);
  // The old /admin/today number, for contrast — this is what it omitted.
  assert.equal((r.byRail.connectFee ?? 0) + (r.byRail.shopMargin ?? 0), 198.22);
});

test('every rail contributes to the total', () => {
  const r = computeBhcRevenue(
    snapshot({
      payments: [connectPayment(), brokerPayment()],
      rancherOrders: [shopOrder()],
      referrals: [legacyClose()],
      consumers: [founder()],
      brands: [brand()],
    }),
    ALWAYS,
  );
  assert.deepEqual(r.byRail, {
    connectFee: 153.15,
    brokerDeposit: 200,
    shopMargin: 45.07,
    legacyCommission: 207,
    founders: 1000,
    brandPartner: 295,
  });
  assert.equal(r.total, 1900.22);
});

// ── broker: split out, but never lost and never doubled ───────────────────

test('BROKER: the deposit IS the commission — counted ONCE, at face value', () => {
  const r = computeBhcRevenue(snapshot({ payments: [brokerPayment()] }), ALWAYS);
  assert.equal(r.byRail.brokerDeposit, 200, 'the $200 deposit, not $400');
  assert.equal(r.byRail.connectFee, 0, 'a broker row is not Connect fee revenue');
});

test('BROKER: splitting the rails out re-labels, it never changes the total', () => {
  // computeConnectFeeCaptured sums Platform Fee Cents over ALL succeeded rows,
  // so broker income was already inside it — silently, under a Connect label.
  const payments = [connectPayment(), brokerPayment()];
  const r = computeBhcRevenue(snapshot({ payments }), ALWAYS);
  assert.equal(
    (r.byRail.connectFee ?? 0) + (r.byRail.brokerDeposit ?? 0),
    computeConnectFeeCaptured(payments as any),
  );
});

test('a BROKER close cannot be counted twice (deposit AND legacy commission)', () => {
  // A hand-stamped Commission Due on a broker referral would otherwise be
  // added to the deposit BHC already kept in full.
  const r = computeBhcRevenue(
    snapshot({
      payments: [brokerPayment()],
      referrals: [legacyClose({ 'Match Type': 'Broker — Deposit', 'Commission Due': 200 })],
    }),
    ALWAYS,
  );
  assert.equal(r.byRail.legacyCommission, 0);
  assert.equal(r.total, 200);
});

// ── what must NOT count ────────────────────────────────────────────────────

test('unsettled payments never count (pending / abandoned / failed)', () => {
  const r = computeBhcRevenue(
    snapshot({
      payments: [
        connectPayment({ 'Status': 'pending' }),
        connectPayment({ 'Status': 'abandoned' }),
        connectPayment({ 'Status': 'refunded' }),
      ],
    }),
    ALWAYS,
  );
  assert.equal(r.byRail.connectFee, 0);
});

test('a refunded or cancelled shop order is not earned revenue', () => {
  const r = computeBhcRevenue(
    snapshot({
      rancherOrders: [
        shopOrder({ 'Status': 'Refunded' }),
        shopOrder({ 'Status': 'Cancelled' }),
        shopOrder({ 'Status': 'Canceled' }),
      ],
    }),
    ALWAYS,
  );
  assert.equal(r.byRail.shopMargin, 0);
});

test('a tier_v2 (deposit-rail) close carries no legacy commission', () => {
  const r = computeBhcRevenue(
    snapshot({
      referrals: [legacyClose({ 'Deposit Paid At': '2026-07-03T17:15:50.021Z', 'Commission Due': 0 })],
    }),
    ALWAYS,
  );
  assert.equal(r.byRail.legacyCommission, 0);
});

test('an un-won referral carries no commission', () => {
  const r = computeBhcRevenue(
    snapshot({ referrals: [legacyClose({ 'Status': 'Awaiting Payment' })] }),
    ALWAYS,
  );
  assert.equal(r.byRail.legacyCommission, 0);
});

test('a comped founder ($0) and an unpaid brand add nothing', () => {
  const r = computeBhcRevenue(
    snapshot({
      consumers: [founder({ 'Tier Amount Paid': 0 })],
      brands: [brand({ 'Amount Paid': 0, 'Paid At': null })],
    }),
    ALWAYS,
  );
  assert.equal(r.byRail.founders, 0);
  assert.equal(r.byRail.brandPartner, 0);
});

// ── the range predicate reaches every rail ────────────────────────────────

test('RANGE: each rail is dated by its own money-moved stamp', () => {
  const august = (iso: string) => iso.startsWith('2026-08');
  const rows = snapshot({
    payments: [
      connectPayment({ 'Captured At': '2026-07-19T03:34:26.935Z' }), // out
      connectPayment({ 'Captured At': '2026-08-11T00:01:48.110Z' }), // in
      brokerPayment({ 'Captured At': '2026-08-12T00:00:00.000Z' }),  // in
    ],
    rancherOrders: [shopOrder({ 'Ordered At': '2026-07-15T00:00:00.000Z' })], // out
    referrals: [
      legacyClose({ 'Closed At': '2026-08-10T22:19:53.482Z' }),  // in
      legacyClose({ 'Closed At': '2026-05-10T19:25:16.624Z' }),  // out
    ],
    consumers: [founder({ 'Subscribed At': '2026-08-05T00:00:00.000Z' })], // in
    brands: [brand({ 'Paid At': '2026-06-06T00:00:00.000Z' })],            // out
  });
  const r = computeBhcRevenue(rows, august);
  assert.deepEqual(r.byRail, {
    connectFee: 153.15,
    brokerDeposit: 200,
    shopMargin: 0,
    legacyCommission: 207,
    founders: 1000,
    brandPartner: 0,
  });
  assert.equal(r.total, 1560.15);
});

test('RANGE: a row with no usable timestamp is out of every bounded range', () => {
  const r = computeBhcRevenue(
    snapshot({
      payments: [connectPayment({ 'Captured At': null, 'Created At': null })],
      referrals: [legacyClose({ 'Closed At': null })],
      consumers: [founder({ 'Subscribed At': null })],
      brands: [brand({ 'Paid At': null })],
      rancherOrders: [shopOrder({ 'Ordered At': null })],
    }),
    () => true,
  );
  assert.equal(r.total, 0, 'undated money cannot be claimed for a day or a month');
});

test('RANGE: a Connect row predating Captured At falls back to Created At', () => {
  const r = computeBhcRevenue(
    snapshot({ payments: [connectPayment({ 'Captured At': null, 'Created At': '2026-08-11T00:00:00.000Z' })] }),
    (iso) => iso.startsWith('2026-08'),
  );
  assert.equal(r.byRail.connectFee, 153.15);
});

// ── failure contract ──────────────────────────────────────────────────────

test('a failed table read degrades that rail to null, never to a silent zero', () => {
  const r = computeBhcRevenue(
    snapshot({ payments: null, referrals: [legacyClose()] }),
    ALWAYS,
  );
  assert.equal(r.byRail.connectFee, null);
  assert.equal(r.byRail.brokerDeposit, null);
  assert.equal(r.byRail.legacyCommission, 207);
  assert.equal(r.total, 207);
  assert.deepEqual(r.unreadableRails, ['connectFee', 'brokerDeposit']);
  assert.equal(r.complete, false, 'a total missing a rail must not claim to be complete');
});

test('every rail readable ⇒ complete, and nothing is listed as unreadable', () => {
  const r = computeBhcRevenue(snapshot(), ALWAYS);
  assert.equal(r.complete, true);
  assert.deepEqual(r.unreadableRails, []);
});

// ── the standalone shop-margin helpers share the same refund rule ──────────
// /admin's command-center renders a "Shop sales · $X BHC margin" tile from
// computeProductMargin directly. If only lib/bhcRevenue filtered terminal
// orders, that tile would go on counting refunded money and disagree with the
// total two tiles away — the exact drift this whole change exists to end.

test('computeProductMargin excludes refunded / cancelled orders', () => {
  const rows = [
    { 'BHC Margin': 45.07, 'Status': 'Shipped', 'Ordered At': '2026-08-01T00:00:00.000Z' },
    { 'BHC Margin': 100, 'Status': 'Refunded', 'Ordered At': '2026-08-02T00:00:00.000Z' },
    { 'BHC Margin': 100, 'Status': 'Cancelled', 'Ordered At': '2026-08-03T00:00:00.000Z' },
    { 'BHC Margin': 100, 'Status': { name: 'Canceled' }, 'Ordered At': '2026-08-04T00:00:00.000Z' },
  ];
  assert.equal(computeProductMargin(rows as any), 45.07);
  assert.equal(computeProductMarginInRange(rows as any, () => true), 45.07);
});

test('computeProductMargin still counts New and Shipped orders', () => {
  const rows = [
    { 'BHC Margin': 10, 'Status': 'New', 'Ordered At': '2026-08-01T00:00:00.000Z' },
    { 'BHC Margin': 20, 'Status': 'Shipped', 'Ordered At': '2026-08-02T00:00:00.000Z' },
    { 'BHC Margin': 5, 'Ordered At': '2026-08-03T00:00:00.000Z' },
  ];
  assert.equal(computeProductMargin(rows as any), 35);
});
