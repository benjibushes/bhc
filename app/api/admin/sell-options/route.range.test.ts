// GET /api/admin/sell-options — WEIGHT-PRICED (range) broker cuts in the sell
// console's menu.
//
// Pins the operator money truth for a hanging-weight cut:
//   "buyer price: $floor–$max (hanging weight)" · "you keep $deposit" (EXACT)
//   · "ranch collects $floor−dep–$max−dep"
// and that exact-mode cuts + the disabled-reason machinery are untouched.
//
// Kept in its OWN file so the pre-existing route tests stay unmodified (the
// exact-mode pins there must keep passing byte-for-byte).
//
// Synthetic ranch names and record ids throughout — the repo is PUBLIC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrokerSellRancher } from './route';

function weightRancher(over: Record<string, any> = {}) {
  return {
    id: 'recBROKERWEIGHT1',
    'Ranch Name': 'Granite Hollow Beef',
    State: 'MT',
    'Broker Rail': true,
    'Quarter Price': 1050,
    'Quarter Price Max': 1225,
    'Quarter Deposit': 100,
    'Half Price': 2025,
    'Half Price Max': 2363,
    'Half Deposit': 200,
    ...over,
  };
}

const cutOf = (r: ReturnType<typeof buildBrokerSellRancher>, cut: string) =>
  r.cuts.find((c) => c.cut === cut)!;

test('a WEIGHT-PRICED cut shows the exact keep and the range collect', () => {
  const row = buildBrokerSellRancher(weightRancher(), 'MT');
  const half = cutOf(row, 'half');
  assert.equal(half.sellable, true);
  assert.equal(half.weightPriced, true);
  assert.equal(half.price, 2025); // FLOOR
  assert.equal(half.priceMax, 2363); // ceiling
  assert.equal(half.deposit, 200); // EXACT
  assert.equal(half.bhcKeeps, 200); // EXACT — the deposit IS the commission
  assert.equal(half.ranchCollects, 1825); // floor − deposit
  assert.equal(half.ranchCollectsMax, 2163); // ceiling − deposit
  // The split invariant holds at BOTH ends of the range.
  assert.equal(half.bhcKeeps + half.ranchCollects, half.price);
  assert.equal(half.bhcKeeps + half.ranchCollectsMax, half.priceMax);
});

test('an EXACT cut collapses the max fields — weightPriced false, ceilings == floors', () => {
  const row = buildBrokerSellRancher(weightRancher({ 'Half Price Max': undefined }), 'MT');
  const half = cutOf(row, 'half');
  assert.equal(half.sellable, true);
  assert.equal(half.weightPriced, false);
  assert.equal(half.priceMax, half.price);
  assert.equal(half.ranchCollectsMax, half.ranchCollects);
});

test('Max ≤ floor is exact mode in the console too', () => {
  const row = buildBrokerSellRancher(weightRancher({ 'Half Price Max': 2025 }), 'MT');
  assert.equal(cutOf(row, 'half').weightPriced, false);
});

test('the disabled-reason machinery is untouched — an unpriced cut still refuses with a reason', () => {
  const row = buildBrokerSellRancher(weightRancher(), 'MT');
  const whole = cutOf(row, 'whole'); // never priced on this fixture
  assert.equal(whole.sellable, false);
  assert.ok(whole.reason.length > 0);
  assert.equal(whole.weightPriced, false);
  assert.equal(whole.priceMax, 0);
  assert.equal(whole.ranchCollectsMax, 0);
});

test('a ceiling cannot rescue a cut with no deposit — still not sellable', () => {
  const row = buildBrokerSellRancher(weightRancher({ 'Half Deposit': undefined }), 'MT');
  const half = cutOf(row, 'half');
  assert.equal(half.sellable, false);
  assert.match(half.reason, /deposit/i);
});
