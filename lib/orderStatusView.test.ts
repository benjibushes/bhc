// lib/orderStatusView.test.ts
//
// The buyer order-status page is a dumb renderer over this view model, so the
// honesty rules live here: a pickup order never says "shipped", a deposit
// order never says "on its way", a refunded/cancelled order never shows a
// tracking link, and a garbage tracking number renders nothing at all.
//
// Runner: npx tsx --test lib/orderStatusView.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrderStatusView,
  orderKindFromRef,
  orderStateFromStatus,
  promisedShipByIso,
} from './orderStatusView';

const shipOrder = (over: Record<string, any> = {}) => ({
  id: 'recAAAAAAAAAAAAAA',
  'Order Ref': 'Sampler Box — Sam Buyer',
  'Product Name': 'Sampler Box',
  Quantity: 1,
  'Buyer Name': 'Sam Buyer',
  'Buyer Paid': 375,
  Status: 'New',
  'Ordered At': '2026-08-01T00:00:00.000Z',
  'Ship To Address': 'Sam Buyer\n1 Test Way\nTestville, TT, 00000',
  'Rancher Name': 'Test Ranch',
  ...over,
});

// ── parsing helpers ─────────────────────────────────────────────────────────

test('orderKindFromRef reads the compounding DEPOSIT/PICKUP markers', () => {
  assert.equal(orderKindFromRef('Sampler Box — Sam'), 'ship');
  assert.equal(orderKindFromRef('PICKUP — Sampler Box — Sam'), 'pickup');
  assert.equal(orderKindFromRef('DEPOSIT — Sampler Box — Sam'), 'deposit');
  // deposit wins on a compound ref (confirming size + balance precedes pickup)
  assert.equal(orderKindFromRef('DEPOSIT — PICKUP — Box — Sam'), 'deposit');
  assert.equal(orderKindFromRef(undefined), 'ship');
});

test('orderStateFromStatus maps every Airtable option, blank ⇒ new', () => {
  assert.equal(orderStateFromStatus('New'), 'new');
  assert.equal(orderStateFromStatus('Shipped'), 'shipped');
  assert.equal(orderStateFromStatus('Delivered'), 'delivered');
  assert.equal(orderStateFromStatus('Refunded'), 'refunded');
  assert.equal(orderStateFromStatus('Cancelled'), 'cancelled');
  assert.equal(orderStateFromStatus('Canceled'), 'cancelled'); // imported spelling
  assert.equal(orderStateFromStatus(''), 'new');
  assert.equal(orderStateFromStatus(undefined), 'new');
});

test('promisedShipByIso adds the promised days, and refuses to guess', () => {
  assert.equal(promisedShipByIso('2026-08-01T00:00:00.000Z', 3), '2026-08-04T00:00:00.000Z');
  assert.equal(promisedShipByIso('2026-08-01T00:00:00.000Z', null), '');
  assert.equal(promisedShipByIso('2026-08-01T00:00:00.000Z', 0), '');
  assert.equal(promisedShipByIso('', 3), '');
  assert.equal(promisedShipByIso('not a date', 3), '');
});

// ── tracking ────────────────────────────────────────────────────────────────

test('a carrier + tracking number becomes a clickable carrier URL', () => {
  const v = buildOrderStatusView(
    shipOrder({ Status: 'Shipped', 'Tracking Number': '1Z999AA10123456784', 'Shipping Carrier': 'UPS Ground' }),
  );
  assert.equal(v.trackingUrl, 'https://www.ups.com/track?tracknum=1Z999AA10123456784');
  assert.equal(v.statusLabel, 'shipped');
});

test('no carrier still yields a useful link; garbage tracking yields none', () => {
  const noCarrier = buildOrderStatusView(shipOrder({ Status: 'Shipped', 'Tracking Number': '9400111899223' }));
  assert.ok(noCarrier.trackingUrl?.startsWith('https://www.google.com/search?'), noCarrier.trackingUrl || '');
  const garbage = buildOrderStatusView(shipOrder({ Status: 'Shipped', 'Tracking Number': 'x' }));
  assert.equal(garbage.trackingUrl, null);
});

test('a pickup order never carries tracking, even if a number leaked onto the row', () => {
  const v = buildOrderStatusView(
    shipOrder({ 'Order Ref': 'PICKUP — Box — Sam', Status: 'Shipped', 'Tracking Number': '1Z999AA10123456784' }),
  );
  assert.equal(v.kind, 'pickup');
  assert.equal(v.trackingNumber, '');
  assert.equal(v.trackingUrl, null);
  assert.equal(v.statusLabel, 'picked up');
});

// ── terminal states ─────────────────────────────────────────────────────────

test('a refunded order says refunded and shows no tracking or ship-to promise', () => {
  const v = buildOrderStatusView(
    shipOrder({ Status: 'Refunded', 'Refunded At': '2026-08-05T00:00:00.000Z', 'Tracking Number': '1Z999AA10123456784' }),
  );
  assert.equal(v.state, 'refunded');
  assert.equal(v.statusLabel, 'refunded');
  assert.equal(v.trackingUrl, null);
  assert.equal(v.endedAt, '2026-08-05T00:00:00.000Z');
  assert.match(v.statusDetail, /refunded/i);
});

test('a cancelled order reads as cancelled + refunded, distinct from a plain refund', () => {
  const v = buildOrderStatusView(
    shipOrder({ Status: 'Cancelled', 'Cancelled At': '2026-08-02T00:00:00.000Z' }),
  );
  assert.equal(v.state, 'cancelled');
  assert.equal(v.statusLabel, 'cancelled');
  assert.match(v.statusDetail, /cancelled/i);
  assert.equal(v.endedAt, '2026-08-02T00:00:00.000Z');
  // 'Cancelled At' wins over a stale 'Refunded At' on the same row.
  const both = buildOrderStatusView(
    shipOrder({ Status: 'Cancelled', 'Cancelled At': '2026-08-02T00:00:00.000Z', 'Refunded At': '2026-08-03T00:00:00.000Z' }),
  );
  assert.equal(both.endedAt, '2026-08-02T00:00:00.000Z');
});

// ── kind-specific copy ──────────────────────────────────────────────────────

test('a deposit order is never told its box is on the way', () => {
  const v = buildOrderStatusView(shipOrder({ 'Order Ref': 'DEPOSIT — Half — Sam' }));
  assert.equal(v.kind, 'deposit');
  assert.match(v.statusDetail, /balance/i);
  assert.doesNotMatch(v.statusDetail, /tracking/i);
});

test('a pickup order surfaces the pickup address + instructions, never a ship-to', () => {
  const v = buildOrderStatusView(shipOrder({ 'Order Ref': 'PICKUP — Box — Sam' }), {
    Email: 'ranch@example.test',
    Phone: '555-0100',
    'Pickup Address': '9 Ranch Rd',
    'Pickup Instructions': 'gate code 1234',
  });
  assert.equal(v.pickupAddress, '9 Ranch Rd');
  assert.equal(v.pickupInstructions, 'gate code 1234');
  assert.equal(v.shipTo, '');
  assert.equal(v.rancherEmail, 'ranch@example.test');
  assert.equal(v.rancherPhone, '555-0100');
});

test('a missing rancher row degrades to the order alone (page still renders)', () => {
  const v = buildOrderStatusView(shipOrder(), null);
  assert.equal(v.rancherEmail, '');
  assert.equal(v.rancherPhone, '');
  assert.equal(v.productName, 'Sampler Box');
  assert.equal(v.buyerFirstName, 'Sam');
  assert.equal(v.quantity, 1);
});

// ── the promise ─────────────────────────────────────────────────────────────

test('runningLate is true only for an unshipped ship order past its own promise', () => {
  const late = buildOrderStatusView(shipOrder(), null, 3, '2026-08-06T00:00:00.000Z');
  assert.equal(late.promisedShipBy, '2026-08-04T00:00:00.000Z');
  assert.equal(late.runningLate, true);

  const onTime = buildOrderStatusView(shipOrder(), null, 3, '2026-08-02T00:00:00.000Z');
  assert.equal(onTime.runningLate, false);

  // shipped ⇒ never "late"
  const shipped = buildOrderStatusView(shipOrder({ Status: 'Shipped' }), null, 3, '2026-08-09T00:00:00.000Z');
  assert.equal(shipped.runningLate, false);

  // no promise on file ⇒ never claims late
  const noPromise = buildOrderStatusView(shipOrder(), null, null, '2026-09-01T00:00:00.000Z');
  assert.equal(noPromise.promisedShipBy, '');
  assert.equal(noPromise.runningLate, false);

  // pickup orders have no ship promise at all
  const pickup = buildOrderStatusView(shipOrder({ 'Order Ref': 'PICKUP — Box — Sam' }), null, 3, '2026-09-01T00:00:00.000Z');
  assert.equal(pickup.promisedShipBy, '');
  assert.equal(pickup.runningLate, false);
});

test('quantity is clamped to at least 1 and money reads straight off the row', () => {
  const v = buildOrderStatusView(shipOrder({ Quantity: 0, 'Buyer Paid': 375 }));
  assert.equal(v.quantity, 1);
  assert.equal(v.buyerPaid, 375);
});
