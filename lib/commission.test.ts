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
import { netEarningsFor } from './commission';

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
