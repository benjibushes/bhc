import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isBrokerPaymentRow,
  capturedTotalCents,
  buildRefundedRancherNotice,
} from './payments';
import { BROKER_PAYMENT_TYPE, BROKER_MATCH_TYPE } from '@/lib/brokerRail';

// ──────────────────────────────────────────────────────────────────────────
// REFUND, RAIL-AWARE — lib/contracts/payments.
//
// A refund on the BROKER rail comes out of BuyHalfCow's OWN Stripe balance:
// the represented ranch has no connected account, collected nothing, and owes
// nothing back. Every number and every sentence the refund path emits has to
// know that.
//
// Synthetic names throughout — the repo is PUBLIC.
// ──────────────────────────────────────────────────────────────────────────

const SITE = 'https://www.buyhalfcow.com';

// ---------------------------------------------------------------------------
// The rancher notice — P1. The Connect copy is FALSE on the broker rail.
// ---------------------------------------------------------------------------

test("BROKER notice: never claims the money left the rancher's Stripe balance", () => {
  const n = buildRefundedRancherNotice({
    brokerRail: true,
    rancherFirst: 'Sam',
    buyerName: 'Jordan Blake',
    refundedDollars: 400,
    siteUrl: SITE,
  });
  assert.ok(
    !/your Stripe balance/i.test(n.html),
    'THE LIE: a represented ranch has no Stripe account for money to come out of',
  );
  assert.match(n.html, /out of our own account/i, 'says whose balance it actually was');
  assert.match(n.html, /don't owe anything/i, 'the ranch is never invoiced on this rail');
});

test('BROKER notice: no dashboard link and no dashboard claim — he has no login', () => {
  const n = buildRefundedRancherNotice({ brokerRail: true, buyerName: 'Jordan Blake', siteUrl: SITE });
  assert.ok(!n.html.includes('/rancher#deals'), 'a represented ranch cannot open the dashboard');
  assert.ok(!/in your dashboard/i.test(n.html));
});

test('BROKER notice: still carries the two facts that matter operationally', () => {
  const n = buildRefundedRancherNotice({ brokerRail: true, buyerName: 'Jordan Blake', siteUrl: SITE });
  assert.match(n.html, /Do not fulfill this order/i, 'the ranch must not butcher for a gone buyer');
  assert.match(n.html, /balance at pickup/i, 'and must not expect the balance he was going to collect');
  assert.match(n.html, /slot is open again/i);
});

test('BROKER notice: rides its own templateName so the two rails are separable', () => {
  assert.equal(
    buildRefundedRancherNotice({ brokerRail: true, siteUrl: SITE }).templateName,
    'deposit_refunded_rancher_broker',
  );
  assert.match(
    buildRefundedRancherNotice({ brokerRail: true, buyerName: 'Jordan Blake', siteUrl: SITE }).subject,
    /Jordan cancelled/,
  );
});

test('CONNECT notice: byte-identical to the copy that shipped before the split', () => {
  const n = buildRefundedRancherNotice({
    brokerRail: false,
    rancherFirst: 'Sam',
    buyerName: 'Jordan Blake',
    refundedDollars: 440,
    siteUrl: SITE,
  });
  assert.equal(n.templateName, 'deposit_refunded_rancher');
  assert.equal(n.subject, "Jordan's deposit was refunded — deal closed");
  assert.match(n.html, /<p>hey Sam,<\/p>/);
  assert.match(n.html, /Jordan Blake<\/strong>'s deposit \(\$440\) was fully refunded and the deal is closed\./);
  assert.match(n.html, /The refund was returned out of your Stripe balance/);
  assert.match(n.html, /the deal now shows as Refunded in your dashboard/);
  assert.match(n.html, /href="https:\/\/www\.buyhalfcow\.com\/rancher#deals"/);
});

test('both rails: a missing name and a zero amount degrade without printing junk', () => {
  for (const brokerRail of [true, false]) {
    const n = buildRefundedRancherNotice({ brokerRail, siteUrl: SITE });
    assert.match(n.subject, /Your buyer/, 'no empty possessive in the subject');
    assert.match(n.html, /<p>hey there,<\/p>/, 'neutral greeting when the first name is unknown');
    assert.match(n.html, /your buyer<\/strong>/);
    assert.ok(!n.html.includes('($0)'), 'never print a zero-dollar refund amount');
    assert.ok(!n.html.includes('undefined') && !n.html.includes('NaN'));
  }
});

// ---------------------------------------------------------------------------
// The captured total — the number a "full refund" is measured against
// ---------------------------------------------------------------------------

test('BROKER row: Amount Cents and Platform Fee Cents are the SAME dollars', () => {
  // recordBrokerDeposit writes the deposit into both fields deliberately.
  const row = { 'Type': BROKER_PAYMENT_TYPE, 'Amount Cents': 40000, 'Platform Fee Cents': 40000 };
  assert.equal(capturedTotalCents(row), 40000);
});

test('BROKER row: the double-count would have BROKEN the full-refund restore', () => {
  // If captured reads 80000, a real $400 full refund (40000) is < captured →
  // isFullRefund false → no restore → referral stays 'Awaiting Payment' with a
  // stale Deposit Paid At and the ranch's slot held forever.
  const row = { 'Type': BROKER_PAYMENT_TYPE, 'Amount Cents': 40000, 'Platform Fee Cents': 40000 };
  const captured = capturedTotalCents(row);
  assert.ok(40000 >= captured, 'a refund of the whole real charge must read as FULL');
});

test('CONNECT row: the fee is charged ON TOP, so captured is the sum (unchanged)', () => {
  assert.equal(capturedTotalCents({ 'Amount Cents': 40000, 'Platform Fee Cents': 4000 }), 44000);
});

test('Total Charged Cents wins on both rails when settlement stamped it', () => {
  assert.equal(
    capturedTotalCents({ 'Type': BROKER_PAYMENT_TYPE, 'Amount Cents': 40000, 'Total Charged Cents': 40000 }),
    40000,
  );
  assert.equal(
    capturedTotalCents({ 'Amount Cents': 40000, 'Platform Fee Cents': 4000, 'Total Charged Cents': 45500 }),
    45500,
  );
});

// ---------------------------------------------------------------------------
// Rail detection inside the restore path
// ---------------------------------------------------------------------------

test('isBrokerPaymentRow: exact on the ledger marker, fails closed otherwise', () => {
  assert.equal(isBrokerPaymentRow({ 'Type': BROKER_PAYMENT_TYPE }), true);
  assert.equal(isBrokerPaymentRow({ 'Type': { name: BROKER_PAYMENT_TYPE } }), true);
  assert.equal(isBrokerPaymentRow({}), false, 'Connect rows carry no Type at all');
  assert.equal(isBrokerPaymentRow(null), false);
  assert.equal(isBrokerPaymentRow({ 'Type': 'broker' }), false);
});

const src = readFileSync(fileURLToPath(new URL('./payments.ts', import.meta.url)), 'utf8');

test('the restore path detects the rail from EITHER the ledger row or the referral', () => {
  // The Payments Type is the primary signal, but a hand-fixed row can lose it;
  // Match Type is stamped at referral CREATION and survives that.
  assert.match(
    src,
    /const brokerRail = isBrokerPaymentRow\(payment\) \|\| isBrokerReferralRow\(referral\);/,
  );
  assert.match(src, /buildRefundedRancherNotice\(\{\s*\n\s*brokerRail,/, 'the notice is rail-aware at the call site');
  // The I/O path must SPREAD the built notice, never hand-roll subject/html
  // beside it — an inline copy is exactly how the rail-blind wording survived.
  assert.match(src, /await sendEmail\(\{ to: rancherEmail, \.\.\.notice \}\)/);
  const restore = src.slice(src.indexOf('async function restoreReferralAfterRefund'));
  assert.ok(
    !/your Stripe balance/.test(restore),
    'no rail-blind money claim may live in the I/O path',
  );
});

test('the full-refund gate reads the RAIL-AWARE captured total', () => {
  assert.match(src, /const capturedCents = capturedTotalCents\(payment\);/);
  assert.ok(
    !/const capturedCents =\s*\n?\s*totalChargedCents > 0/.test(src),
    'the old rail-blind inline chain must not come back',
  );
});

test('BROKER_MATCH_TYPE is the referral-side marker the detection leans on', () => {
  // Guard against a rename drifting the two markers apart.
  assert.equal(BROKER_MATCH_TYPE, 'Broker — Deposit');
  assert.equal(BROKER_PAYMENT_TYPE, 'broker_deposit');
});
