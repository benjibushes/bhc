import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { refundRailFor, buildRefundRequest } from './route';
import { isBrokerPaymentRow, capturedTotalCents } from '@/lib/contracts/payments';
import { BROKER_PAYMENT_TYPE } from '@/lib/brokerRail';

// ──────────────────────────────────────────────────────────────────────────
// POST /api/admin/payments/refund/[paymentId] — TWO RAILS, ONE ROUTE.
//
// THE P0 THIS PINS: the route resolved `Stripe Connect Account Id` off the
// rancher and 422'd without one. A represented (broker-rail) ranch has NO
// connected account BY DEFINITION, so every broker deposit was un-refundable
// — while the live reserve page promised the buyer "fully refundable until
// the ranch confirms your animal … any refund comes straight back from
// BuyHalfCow".
//
// The handler is Stripe + Airtable + admin-session bound, so the decisions
// that carry money are exported as pure functions and pinned here. NOTHING IN
// THIS FILE CALLS STRIPE.
//
// Synthetic ids throughout — the repo is PUBLIC.
// ──────────────────────────────────────────────────────────────────────────

const BROKER_ROW = { 'Type': BROKER_PAYMENT_TYPE, 'Amount Cents': 40000, 'Platform Fee Cents': 40000 };
const CONNECT_ROW = { 'Amount Cents': 40000, 'Platform Fee Cents': 4000 };

// ---------------------------------------------------------------------------
// refundRailFor — read the LEDGER, never the rancher
// ---------------------------------------------------------------------------

test('a broker_deposit Payments row selects the BROKER rail', () => {
  assert.equal(refundRailFor(BROKER_ROW), 'broker');
  assert.equal(isBrokerPaymentRow(BROKER_ROW), true);
});

test('a Connect deposit row (no Type at all) selects the CONNECT rail', () => {
  // recordDeposit never writes Type — absence IS the Connect marker.
  assert.equal(refundRailFor(CONNECT_ROW), 'connect');
});

test('the rail read tolerates Airtable\'s {name} singleSelect object form', () => {
  assert.equal(refundRailFor({ 'Type': { name: BROKER_PAYMENT_TYPE } }), 'broker');
});

test('the rail read FAILS CLOSED to connect on garbage, null, and near-misses', () => {
  // A wrong 'broker' read would strip reverse_transfer off a real Connect
  // refund and leave BHC's application fee stranded.
  assert.equal(refundRailFor(null), 'connect');
  assert.equal(refundRailFor({}), 'connect');
  assert.equal(refundRailFor({ 'Type': '' }), 'connect');
  assert.equal(refundRailFor({ 'Type': 'broker' }), 'connect');
  assert.equal(refundRailFor({ 'Type': 'broker_deposits' }), 'connect');
  assert.equal(refundRailFor({ 'Type': 'deposit' }), 'connect');
});

test('surrounding whitespace on the marker still reads as broker', () => {
  assert.equal(refundRailFor({ 'Type': ' broker_deposit ' }), 'broker');
});

// ---------------------------------------------------------------------------
// buildRefundRequest — BROKER: platform account, none of the Connect params
// ---------------------------------------------------------------------------

test('BROKER full refund: platform account, no stripeAccount, no Connect params', () => {
  const { params, options } = buildRefundRequest({
    rail: 'broker',
    piId: 'pi_broker_1',
    paymentId: 'recPAY0000000001',
    isPartial: false,
    refundAppFee: true, // the route default — must be IGNORED on this rail
  });

  // Every one of these three is a Connect-only concept. Stripe errors on each
  // of them for a plain platform charge, so their absence is the fix.
  assert.ok(!('stripeAccount' in options), 'no connected account header');
  assert.ok(!('reverse_transfer' in params), 'there is no transfer to reverse');
  assert.ok(!('refund_application_fee' in params), 'there is no application fee');

  assert.equal(params.payment_intent, 'pi_broker_1');
  assert.ok(!('amount' in params), 'a full refund sends no amount');
  assert.equal(options.idempotencyKey, 'refund-recPAY0000000001-full');
  assert.equal(params.metadata.rail, 'broker');
});

test('BROKER partial refund: amount rides through, key is amount-scoped, still no Connect params', () => {
  const { params, options } = buildRefundRequest({
    rail: 'broker',
    piId: 'pi_broker_1',
    paymentId: 'recPAY0000000001',
    isPartial: true,
    amountCents: 15000,
    reason: 'requested_by_customer',
    refundAppFee: false,
  });
  assert.equal(params.amount, 15000);
  assert.equal(params.reason, 'requested_by_customer');
  assert.equal(params.metadata.partial, 'true');
  assert.equal(options.idempotencyKey, 'refund-recPAY0000000001-15000');
  assert.ok(!('reverse_transfer' in params));
  assert.ok(!('refund_application_fee' in params));
  assert.ok(!('stripeAccount' in options));
});

test('BROKER: refundAppFee can never leak a Connect parameter, in either position', () => {
  for (const refundAppFee of [true, false]) {
    const { params, options } = buildRefundRequest({
      rail: 'broker',
      piId: 'pi_1',
      paymentId: 'recPAY0000000001',
      isPartial: false,
      refundAppFee,
      // Even if a caller wrongly hands one over, the broker branch ignores it.
      connectAccountId: 'acct_should_be_ignored',
    });
    assert.ok(!('reverse_transfer' in params));
    assert.ok(!('refund_application_fee' in params));
    assert.ok(!('stripeAccount' in options));
  }
});

// ---------------------------------------------------------------------------
// buildRefundRequest — CONNECT stays byte-identical
// ---------------------------------------------------------------------------

test('CONNECT full refund: byte-identical to the pre-split shape', () => {
  const { params, options } = buildRefundRequest({
    rail: 'connect',
    piId: 'pi_connect_1',
    paymentId: 'recPAY0000000002',
    isPartial: false,
    refundAppFee: true,
    connectAccountId: 'acct_live_1',
  });
  assert.deepEqual(params, {
    payment_intent: 'pi_connect_1',
    reverse_transfer: true,
    refund_application_fee: true,
    metadata: { source: 'admin_console', paymentRowId: 'recPAY0000000002', partial: 'false' },
  });
  assert.deepEqual(options, {
    stripeAccount: 'acct_live_1',
    idempotencyKey: 'refund-recPAY0000000002-full',
  });
});

test('CONNECT partial refund with a reason: byte-identical to the pre-split shape', () => {
  const { params, options } = buildRefundRequest({
    rail: 'connect',
    piId: 'pi_connect_1',
    paymentId: 'recPAY0000000002',
    isPartial: true,
    amountCents: 12500,
    reason: 'duplicate',
    refundAppFee: false,
    connectAccountId: 'acct_live_1',
  });
  assert.deepEqual(params, {
    payment_intent: 'pi_connect_1',
    reason: 'duplicate',
    amount: 12500,
    reverse_transfer: false,
    refund_application_fee: false,
    metadata: { source: 'admin_console', paymentRowId: 'recPAY0000000002', partial: 'true' },
  });
  assert.deepEqual(options, {
    stripeAccount: 'acct_live_1',
    idempotencyKey: 'refund-recPAY0000000002-12500',
  });
});

test('CONNECT carries NO rail marker in metadata — the old shape is preserved exactly', () => {
  const { params } = buildRefundRequest({
    rail: 'connect',
    piId: 'pi_1',
    paymentId: 'recPAY0000000002',
    isPartial: false,
    refundAppFee: true,
    connectAccountId: 'acct_live_1',
  });
  assert.deepEqual(Object.keys(params.metadata), ['source', 'paymentRowId', 'partial']);
});

// ---------------------------------------------------------------------------
// capturedTotalCents — the refund CEILING, rail-aware
// ---------------------------------------------------------------------------

test('BROKER: deposit and platform fee are the SAME dollars — never summed', () => {
  // recordBrokerDeposit writes the deposit into BOTH fields on purpose. Summing
  // them invents a ceiling twice the real charge, so a refund of the whole
  // $400 reads as partial: no restore, referral stuck 'Awaiting Payment' with
  // a stale Deposit Paid At, capacity slot held forever.
  assert.equal(capturedTotalCents(BROKER_ROW), 40000);
});

test('BROKER: Total Charged Cents still wins when settlement stamped it', () => {
  assert.equal(capturedTotalCents({ ...BROKER_ROW, 'Total Charged Cents': 40000 }), 40000);
});

test('CONNECT: the fee is charged ON TOP, so the captured total is the SUM', () => {
  assert.equal(capturedTotalCents(CONNECT_ROW), 44000);
});

test('CONNECT: the fallback chain is unchanged (total → deposit+fee → deposit)', () => {
  assert.equal(capturedTotalCents({ ...CONNECT_ROW, 'Total Charged Cents': 45500 }), 45500);
  assert.equal(capturedTotalCents({ 'Amount Cents': 40000 }), 40000);
  assert.equal(capturedTotalCents({}), 0);
});

// ---------------------------------------------------------------------------
// WIRING PINS — the handler is I/O-bound, so pin what a refactor could revert
// ---------------------------------------------------------------------------

const routeSrc = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8');

test('the rail is decided BEFORE the rancher record is read', () => {
  // THE BUG: `Stripe Connect Account Id` was resolved unconditionally and a
  // missing one 422'd — which is the definition of a represented ranch.
  // Handler body only — the file header discusses the old 422 in prose.
  const handler = routeSrc.slice(routeSrc.indexOf('export async function POST'));
  const railAt = handler.indexOf('const rail = refundRailFor(payment)');
  const rancherReadAt = handler.indexOf("getRecordById(TABLES.RANCHERS");
  // lastIndexOf: the comment above the rail decision quotes the old 422 text.
  const connectGateAt = handler.lastIndexOf("Rancher has no Stripe Connect account");
  assert.ok(railAt > 0, 'the rail decision must exist');
  assert.ok(rancherReadAt > railAt, 'the rancher is read only after the rail is known');
  assert.ok(connectGateAt > railAt, 'the Connect-account 422 sits inside the connect branch');
  assert.match(
    handler,
    /if \(rail === 'connect'\) \{[\s\S]*?Rancher has no Stripe Connect account/,
    'the 422 must be reachable ONLY on the connect rail',
  );
});

test('the handler builds its Stripe call through the pinned builder, never inline', () => {
  assert.match(routeSrc, /buildRefundRequest\(\{[\s\S]*?rail,/, 'params come from the rail-aware builder');
  assert.match(routeSrc, /stripe\.refunds\.create\(refundParams as any, refundOptions as any\)/);
  // An inline reconstruction would bypass every pin above.
  assert.ok(
    !/refunds\.create\(\s*\{\s*payment_intent/.test(routeSrc),
    'no hand-rolled params object at the call site',
  );
});

test('capacity release rides markDepositRefunded, which is still called', () => {
  // markDepositRefunded → restoreReferralAfterRefund is what flips the referral
  // to 'Refunded' and DECRs the held slot ('Awaiting Payment' is in the
  // canonical held set). Dropping this call would refund the money and leave
  // the ranch's slot booked forever.
  assert.match(routeSrc, /await markDepositRefunded\(piId, \{/);
});
