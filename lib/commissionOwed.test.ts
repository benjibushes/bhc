// lib/commissionOwed.test.ts
//
// Ticket 2026-08-03 — a rancher with 2 unpaid commission invoices had NO way
// to pay: every email sent to them carried only the reply-loop fallback (no
// stamped Stripe Invoice URL + unset COMMISSION_PAYMENT_URL), and the
// dashboard had no commission surface at all. These tests pin the selection
// doctrine for the new dashboard "Commission owed" block, the lazy-mint
// endpoint's gate, the cron's mint backfill, and the email pay CTA.
//
// DOCTRINE UNDER TEST (RAIL-PER-ROW, lib/commission.ts):
//   - owing is per REFERRAL, never per rancher — a Connect/tier_v2 rancher
//     with off-rail closes still owes; a deposit-rail row NEVER shows as owed
//     (its fee was buyer-paid at deposit).
//   - a locked 0% rate (Operator tier) is valid → Commission Due 0 is not owed.
//   - the pay path is always a Stripe hosted invoice or the dashboard that
//     mints one — never "reply for a link".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectCommissionOwedRows,
  totalCommissionOwed,
  isCommissionOwedRow,
  referralBelongsToRancher,
  commissionInvoiceEligibility,
  rowsNeedingInvoiceMint,
  commissionPayCta,
} from './commissionOwed';

const RANCHER = 'recRancher000000001';
const OTHER = 'recRancher000000002';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'recRef0000000000001',
    'Status': 'Closed Won',
    'Commission Paid': false,
    'Commission Due': 139.23,
    'Sale Amount': 1392.29,
    'Buyer Name': 'A Buyer',
    'Order Type': 'Half Beef',
    'Closed At': '2026-07-08T16:11:19.008Z',
    'Suggested Rancher': [RANCHER],
    ...overrides,
  } as any;
}

// ── ownership belt ──────────────────────────────────────────────────────────

test('referralBelongsToRancher: matches via Suggested Rancher OR Rancher link', () => {
  assert.equal(referralBelongsToRancher(row(), RANCHER), true);
  assert.equal(referralBelongsToRancher(row({ 'Suggested Rancher': undefined, 'Rancher': [RANCHER] }), RANCHER), true);
  assert.equal(referralBelongsToRancher(row(), OTHER), false);
  assert.equal(referralBelongsToRancher({}, RANCHER), false);
});

// ── isCommissionOwedRow ─────────────────────────────────────────────────────

test('owed: unpaid off-rail Closed Won with positive due', () => {
  assert.equal(isCommissionOwedRow(row()), true);
});

test('NOT owed: deposit-rail row (Deposit Paid At stamped) — fee was buyer-paid at deposit', () => {
  assert.equal(isCommissionOwedRow(row({ 'Deposit Paid At': '2026-07-01T00:00:00.000Z' })), false);
});

test('NOT owed: Commission Paid already true', () => {
  assert.equal(isCommissionOwedRow(row({ 'Commission Paid': true })), false);
});

test('NOT owed: zero Commission Due (locked 0% Operator-tier rate is valid, owes nothing)', () => {
  assert.equal(isCommissionOwedRow(row({ 'Commission Due': 0 })), false);
});

test('NOT owed: non-Closed-Won statuses', () => {
  for (const s of ['Negotiation', 'Awaiting Payment', 'Closed Lost', '']) {
    assert.equal(isCommissionOwedRow(row({ 'Status': s })), false, `status=${s}`);
  }
});

// ── selectCommissionOwedRows ────────────────────────────────────────────────

test('selection: per-ROW rail gate — off-rail rows owed even when sibling rows rode the deposit rail', () => {
  const rows = [
    row({ id: 'recA', 'Closed At': '2026-07-08T00:00:00.000Z' }),
    row({ id: 'recB', 'Deposit Paid At': '2026-06-01T00:00:00.000Z' }), // Connect rail — excluded
    row({ id: 'recC', 'Commission Paid': true }), // settled — excluded
    row({ id: 'recD', 'Suggested Rancher': [OTHER] }), // someone else's — excluded
    row({ id: 'recE', 'Closed At': '2026-07-01T00:00:00.000Z', 'Commission Due': 17.68, 'Sale Amount': 176.77 }),
  ];
  const selected = selectCommissionOwedRows(rows, RANCHER, new Date('2026-08-03T00:00:00.000Z'));
  assert.deepEqual(selected.map((r) => r.referralId), ['recE', 'recA']); // oldest first
  assert.equal(selected[0].ageDays, 33);
  assert.equal(selected[0].stripeInvoiceUrl, null);
});

test('selection: a Connect-only rancher (every row deposit-rail) selects NOTHING — block hidden', () => {
  const rows = [
    row({ id: 'recA', 'Deposit Paid At': '2026-06-01T00:00:00.000Z' }),
    row({ id: 'recB', 'Deposit Paid At': '2026-07-01T00:00:00.000Z' }),
  ];
  assert.deepEqual(selectCommissionOwedRows(rows, RANCHER), []);
});

test('selection: 0%-rate rancher (all rows Commission Due 0) selects NOTHING', () => {
  const rows = [row({ 'Commission Due': 0 }), row({ id: 'recB', 'Commission Due': 0 })];
  assert.deepEqual(selectCommissionOwedRows(rows, RANCHER), []);
});

test('selection: stamped Stripe Invoice URL passes through; blank/whitespace becomes null', () => {
  const rows = [
    row({ id: 'recA', 'Stripe Invoice URL': 'https://invoice.stripe.com/i/x' }),
    row({ id: 'recB', 'Stripe Invoice URL': '   ' }),
  ];
  const selected = selectCommissionOwedRows(rows, RANCHER);
  const byId = Object.fromEntries(selected.map((r) => [r.referralId, r]));
  assert.equal(byId.recA.stripeInvoiceUrl, 'https://invoice.stripe.com/i/x');
  assert.equal(byId.recB.stripeInvoiceUrl, null);
});

test('totalCommissionOwed: cents-precise sum (the real ticket: 17.68 + 139.23 = 156.91)', () => {
  assert.equal(totalCommissionOwed([{ commissionDue: 17.68 }, { commissionDue: 139.23 }]), 156.91);
  assert.equal(totalCommissionOwed([]), 0);
});

// ── commissionInvoiceEligibility (lazy-mint endpoint gate) ──────────────────

test('mint gate: eligible off-rail unpaid row, no existing URL', () => {
  const g = commissionInvoiceEligibility(row(), RANCHER);
  assert.deepEqual(g, { eligible: true, existingUrl: null });
});

test('mint gate: already-stamped row short-circuits to the existing hosted URL (never re-mints)', () => {
  const g = commissionInvoiceEligibility(row({ 'Stripe Invoice URL': 'https://invoice.stripe.com/i/x' }), RANCHER);
  assert.deepEqual(g, { eligible: true, existingUrl: 'https://invoice.stripe.com/i/x' });
});

test('mint gate: refusals — missing, foreign, not closed, paid, deposit-rail, zero due', () => {
  assert.deepEqual(commissionInvoiceEligibility(null, RANCHER), { eligible: false, reason: 'referral-not-found' });
  assert.deepEqual(commissionInvoiceEligibility(row(), OTHER), { eligible: false, reason: 'not-your-referral' });
  assert.deepEqual(commissionInvoiceEligibility(row({ 'Status': 'Negotiation' }), RANCHER), { eligible: false, reason: 'not-closed-won' });
  assert.deepEqual(commissionInvoiceEligibility(row({ 'Commission Paid': true }), RANCHER), { eligible: false, reason: 'already-paid' });
  assert.deepEqual(
    commissionInvoiceEligibility(row({ 'Deposit Paid At': '2026-06-01T00:00:00.000Z' }), RANCHER),
    { eligible: false, reason: 'deposit-rail-nothing-owed' },
  );
  assert.deepEqual(commissionInvoiceEligibility(row({ 'Commission Due': 0 }), RANCHER), { eligible: false, reason: 'nothing-due' });
});

// ── rowsNeedingInvoiceMint (cron backfill) ──────────────────────────────────

test('cron mint backfill: only owed rows missing BOTH stamp fields', () => {
  const needsMint = row({ id: 'recNeed' });
  const hasUrl = row({ id: 'recUrl', 'Stripe Invoice URL': 'https://invoice.stripe.com/i/x' });
  const hasId = row({ id: 'recId', 'Stripe Invoice ID': 'in_123' });
  const depositRail = row({ id: 'recDep', 'Deposit Paid At': '2026-06-01T00:00:00.000Z' });
  const zeroDue = row({ id: 'recZero', 'Commission Due': 0 });
  const minted = rowsNeedingInvoiceMint([needsMint, hasUrl, hasId, depositRail, zeroDue]);
  assert.deepEqual(minted.map((r: any) => r.id), ['recNeed']);
});

// ── commissionPayCta (email pay path — no reply-loop mode exists) ───────────

test('email CTA: hosted Stripe URL wins when present', () => {
  const cta = commissionPayCta({ stripeInvoiceUrl: 'https://invoice.stripe.com/i/x', siteUrl: 'https://www.buyhalfcow.com' });
  assert.deepEqual(cta, { kind: 'hosted', url: 'https://invoice.stripe.com/i/x' });
});

test('email CTA: no hosted URL → dashboard billing pay path, NEVER a reply loop', () => {
  for (const missing of [undefined, null, '', '   ']) {
    const cta = commissionPayCta({ stripeInvoiceUrl: missing as any, siteUrl: 'https://www.buyhalfcow.com/' });
    assert.equal(cta.kind, 'dashboard');
    assert.equal(cta.url, 'https://www.buyhalfcow.com/rancher/billing');
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// RAIL-MATRIX (2026-08-04) — boundary B adversarial rows.
// A data-entry error must never be able to bill a rancher twice (Connect) or
// at all (broker). BROKER_MATCH_TYPE is stamped at referral creation, so the
// belt holds even when the deposit was never paid.
// ═══════════════════════════════════════════════════════════════════════════

const BROKER_MATCH_TYPE = 'Broker — Deposit'; // literal on purpose — the test below
// pins the canonical constant to it; a drift would silently un-protect every
// historical broker row stamped with the old value.

test('BROKER_MATCH_TYPE literal matches the canonical lib/brokerRail constant', async () => {
  const { BROKER_MATCH_TYPE: canonical } = await import('./brokerRail');
  assert.equal(canonical, BROKER_MATCH_TYPE);
});

test('NOT owed: PAID broker row (Match Type + Deposit Paid At from settlement)', () => {
  assert.equal(
    isCommissionOwedRow(
      row({
        'Match Type': BROKER_MATCH_TYPE,
        'Deposit Paid At': '2026-08-01T00:00:00Z',
        'Commission Due': 400, // even a phantom receivable cannot make it owed
      }),
    ),
    false,
  );
});

test('NOT owed: UNPAID broker Closed Won with a phantom Commission Due (the hand-close hole)', () => {
  // Buyer never paid the broker link; the deal closed at the ranch anyway and
  // a hand-close wrote Sale Amount + Commission Due. Without the Match Type
  // belt this row read as legacy-owed and would surface a Pay button / flow
  // into the monthly invoice — billing a represented rancher on a model he
  // never agreed to.
  assert.equal(
    isCommissionOwedRow(
      row({ 'Match Type': BROKER_MATCH_TYPE, 'Commission Due': 180, 'Sale Amount': 1800 }),
    ),
    false,
  );
});

test('NOT owed: Connect row with a phantom Commission Due (Deposit Paid At wins)', () => {
  assert.equal(
    isCommissionOwedRow(
      row({ 'Deposit Paid At': '2026-08-01T00:00:00Z', 'Commission Due': 299.9 }),
    ),
    false,
  );
});

test('mint gate: broker rows refuse with broker-rail-never-invoiced, paid or not', () => {
  const unpaidBroker = row({ 'Match Type': BROKER_MATCH_TYPE, 'Commission Due': 180 });
  const gate = commissionInvoiceEligibility(unpaidBroker, RANCHER);
  assert.deepEqual(gate, { eligible: false, reason: 'broker-rail-never-invoiced' });

  // A PAID broker row hits the deposit-rail refusal first — either way, no invoice.
  const paidBroker = row({
    'Match Type': BROKER_MATCH_TYPE,
    'Deposit Paid At': '2026-08-01T00:00:00Z',
  });
  const paidGate = commissionInvoiceEligibility(paidBroker, RANCHER);
  assert.equal(paidGate.eligible, false);
});

test('selection: broker rows never render in the Commission owed block', () => {
  const rows = [
    row({ id: 'legit', 'Commission Due': 150 }),
    row({ id: 'broker', 'Match Type': BROKER_MATCH_TYPE, 'Commission Due': 400 }),
  ];
  const selected = selectCommissionOwedRows(rows, RANCHER);
  assert.deepEqual(selected.map((r) => r.referralId), ['legit']);
});

test('cron mint backfill: broker rows are never minted even when unstamped', () => {
  const rows = [
    row({ id: 'legit', 'Commission Due': 150 }),
    row({ id: 'broker', 'Match Type': BROKER_MATCH_TYPE, 'Commission Due': 400 }),
  ];
  assert.deepEqual(rowsNeedingInvoiceMint(rows).map((r: any) => r.id), ['legit']);
});
