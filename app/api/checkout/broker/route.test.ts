// GET /api/checkout/broker — the checkout page's money projection, WEIGHT-
// PRICED (range) mode.
//
// The handler is Airtable + auth bound, so the projection is exported pure
// (buildBrokerCheckoutInfo) and pinned here:
//   1. an EXACT cut's payload keeps the exact key set that shipped before
//      weight pricing existed — byte-identical shape;
//   2. a WEIGHT-PRICED cut carries the range (floor is priceCents, ceiling is
//      priceMaxCents) + balance range, and the projection carries the ranch's
//      Broker Pricing Note — the page states "estimated", never a false exact
//      number.
//
// Synthetic ranch names throughout — the repo is PUBLIC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrokerCheckoutInfo } from './route';

function weightRancher(over: Record<string, any> = {}) {
  return {
    id: 'recBROKERWEIGHT1',
    'Ranch Name': 'Granite Hollow Beef',
    'Broker Rail': true,
    'Quarter Price': 1050,
    'Quarter Price Max': 1225,
    'Quarter Deposit': 100,
    'Half Price': 2025,
    'Half Price Max': 2363,
    'Half Deposit': 200,
    'Broker Pricing Note': 'Priced per pound of hanging weight; halves typically hang 350–410 lbs.',
    'Broker Balance Note': 'Cash or check at pickup.',
    ...over,
  };
}

function exactRancher(over: Record<string, any> = {}) {
  return {
    id: 'recBROKEREXACT01',
    'Ranch Name': 'Cedar Draw Beef',
    'Broker Rail': true,
    'Half Price': 1800,
    'Half Deposit': 400,
    ...over,
  };
}

test('EXACT cut payload keeps the pre-existing key set — byte-identical shape', () => {
  const info = buildBrokerCheckoutInfo(exactRancher());
  assert.equal(info.cuts.length, 1);
  assert.deepEqual(info.cuts[0], {
    slug: 'half',
    label: 'Half Cow',
    priceCents: 180000,
    dueNowCents: 40000,
    balanceCents: 140000,
  });
  // No weight-priced cut → the projection carries NO pricingNote key at all.
  assert.ok(!('pricingNote' in info), 'exact-mode payload must not grow a pricingNote key');
});

test('WEIGHT-PRICED cut payload carries the range + the note', () => {
  const info = buildBrokerCheckoutInfo(weightRancher());
  const half: any = info.cuts.find((c: any) => c.slug === 'half');
  assert.ok(half, 'half must be sellable');
  assert.equal(half.weightPriced, true);
  assert.equal(half.priceCents, 202500); // FLOOR
  assert.equal(half.priceMaxCents, 236300); // ceiling
  assert.equal(half.dueNowCents, 20000); // deposit — EXACT
  assert.equal(half.balanceCents, 182500); // floor − deposit
  assert.equal(half.balanceMaxCents, 216300); // ceiling − deposit
  // The pricing note rides the payload for the page to render.
  assert.equal(
    info.pricingNote,
    'Priced per pound of hanging weight; halves typically hang 350–410 lbs.',
  );
});

test('mixed ranch: the exact cut keeps the exact shape beside a weight-priced sibling', () => {
  const info = buildBrokerCheckoutInfo(
    weightRancher({ 'Quarter Price Max': undefined }), // quarter reverts to exact
  );
  const quarter: any = info.cuts.find((c: any) => c.slug === 'quarter');
  const half: any = info.cuts.find((c: any) => c.slug === 'half');
  assert.deepEqual(quarter, {
    slug: 'quarter',
    label: 'Quarter Cow',
    priceCents: 105000,
    dueNowCents: 10000,
    balanceCents: 95000,
  });
  assert.equal(half.weightPriced, true);
  // A weight-priced cut exists, so the note is still carried.
  assert.ok('pricingNote' in info);
});

test('weight-priced ranch with NO pricing note still ranges — note is empty, page renders nothing', () => {
  const info = buildBrokerCheckoutInfo(weightRancher({ 'Broker Pricing Note': undefined }));
  const half: any = info.cuts.find((c: any) => c.slug === 'half');
  assert.equal(half.weightPriced, true);
  assert.equal(info.pricingNote, '');
});

test('malformed Max sells EXACT — the payload shows no range for that cut', () => {
  const info = buildBrokerCheckoutInfo(exactRancher({ 'Half Price Max': 'garbage' }));
  assert.equal(info.cuts.length, 1);
  assert.deepEqual(info.cuts[0], {
    slug: 'half',
    label: 'Half Cow',
    priceCents: 180000,
    dueNowCents: 40000,
    balanceCents: 140000,
  });
  assert.ok(!('pricingNote' in info));
});

test('the composed top-level balanceNote stays PLAIN — the page frames the range itself per cut', () => {
  // Cut selection happens client-side, so the projection cannot pre-compose a
  // per-cut range into the shared note; the page's own range copy carries it.
  const info = buildBrokerCheckoutInfo(weightRancher());
  assert.equal(info.balanceNote, 'Cash or check at pickup.');
});
