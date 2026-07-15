// lib/marketStands.test.ts — the farmers-market stand rules.
// Runner: npx tsx --test lib/marketStands.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildShopStands,
  standServes,
  splitStandsByState,
  visibleStandProducts,
  standsGeoKnown,
  marketStripFor,
  type MarketProductInput,
} from './marketStands';

const mk = (over: Partial<MarketProductInput> = {}): MarketProductInput => ({
  id: 'p1',
  name: 'Jerky',
  price: 25,
  rancher: 'Foodstead',
  weight: '4 oz',
  image: '',
  shelfStable: true,
  depositStyle: false,
  priceRange: '',
  ordersLeft: null,
  shippingCost: 0,
  group: 'jerky',
  localOnly: false,
  rancherId: 'recF',
  rancherState: 'MT',
  rancherServesStates: ['MT', 'WY'],
  rancherSlug: 'foodstead',
  rancherPhoto: '',
  ...over,
});

test('buildShopStands: groups by rancherId, splits pickup from shipped', () => {
  const stands = buildShopStands([
    mk({ id: 'a' }),
    mk({ id: 'b', localOnly: true }),
    mk({ id: 'c', rancherId: 'recS', rancher: 'Silverline', rancherState: 'MO', rancherServesStates: ['MO'] }),
  ]);
  assert.equal(stands.length, 2);
  const food = stands.find((s) => s.key === 'recF')!;
  assert.equal(food.products.length, 1);
  assert.equal(food.pickupProducts.length, 1);
  assert.equal(food.state, 'MT');
});

test('buildShopStands: deal counts attach by rancherId and sort proof-first, then name', () => {
  const stands = buildShopStands(
    [
      mk({ id: 'a', rancherId: 'recA', rancher: 'Zeta Ranch' }),
      mk({ id: 'b', rancherId: 'recB', rancher: 'Alpha Ranch' }),
      mk({ id: 'c', rancherId: 'recC', rancher: 'Mid Ranch' }),
    ],
    { recC: 4 },
  );
  assert.deepEqual(stands.map((s) => s.name), ['Mid Ranch', 'Alpha Ranch', 'Zeta Ranch']);
  assert.equal(stands[0].deals, 4);
  assert.equal(stands[1].deals, 0);
});

test('buildShopStands: a row with no rancherId still gets a stand (name key) and never a deal badge', () => {
  const stands = buildShopStands([mk({ rancherId: '', rancher: 'Mystery Ranch' })], { '': 9 });
  assert.equal(stands.length, 1);
  assert.equal(stands[0].key, 'name:Mystery Ranch');
  assert.equal(stands[0].deals, 0);
});

test('standServes: home state, served state, full-name input all match; unknown never does', () => {
  const [stand] = buildShopStands([mk()]);
  assert.equal(standServes(stand, 'MT'), true);
  assert.equal(standServes(stand, 'WY'), true);
  assert.equal(standServes(stand, 'wyoming'), true);
  assert.equal(standServes(stand, 'TX'), false);
  assert.equal(standServes(stand, ''), false);
  assert.equal(standServes(stand, 'Bogusland'), false);
});

test('splitStandsByState: local vs nationwide; no state → everything nationwide', () => {
  const stands = buildShopStands([
    mk({ id: 'a' }),
    mk({ id: 'c', rancherId: 'recS', rancher: 'Silverline', rancherState: 'MO', rancherServesStates: ['MO'] }),
  ]);
  const { local, nationwide } = splitStandsByState(stands, 'MO');
  assert.deepEqual(local.map((s) => s.name), ['Silverline']);
  assert.deepEqual(nationwide.map((s) => s.name), ['Foodstead']);
  const unset = splitStandsByState(stands, '');
  assert.equal(unset.local.length, 0);
  assert.equal(unset.nationwide.length, 2);
});

test('visibleStandProducts: pickup only for same-HOME-state buyers — never for served-only or unknown states', () => {
  const [stand] = buildShopStands([mk({ id: 'ship' }), mk({ id: 'pick', localOnly: true })]);
  assert.deepEqual(visibleStandProducts(stand, 'MT', 'all', 'price-asc').map((p) => p.id), ['ship', 'pick']);
  // WY is SERVED but the ranch is homed in MT — you can't drive to a pickup in another state.
  assert.deepEqual(visibleStandProducts(stand, 'WY', 'all', 'price-asc').map((p) => p.id), ['ship']);
  assert.deepEqual(visibleStandProducts(stand, '', 'all', 'price-asc').map((p) => p.id), ['ship']);
});

test('visibleStandProducts: chip filters within the stall; sort orders by price', () => {
  const [stand] = buildShopStands([
    mk({ id: 'cheap', group: 'jerky', price: 10 }),
    mk({ id: 'dear', group: 'jerky', price: 90 }),
    mk({ id: 'box', group: 'boxes', price: 50 }),
  ]);
  assert.deepEqual(visibleStandProducts(stand, '', 'jerky', 'price-desc').map((p) => p.id), ['dear', 'cheap']);
  assert.deepEqual(visibleStandProducts(stand, '', 'boxes', 'price-asc').map((p) => p.id), ['box']);
  assert.equal(visibleStandProducts(stand, '', 'shares', 'price-asc').length, 0);
});

test('standsGeoKnown: false when every stand is geo-blind (failed join) — the no-lie guard', () => {
  const blind = buildShopStands([mk({ rancherState: '', rancherServesStates: [] })]);
  assert.equal(standsGeoKnown(blind), false);
  assert.equal(standsGeoKnown(buildShopStands([mk()])), true);
});

test('marketStripFor: shipped needs coverage, pickup needs the home state, unknown state → []', () => {
  const rows = [
    mk({ id: 'ship-mt' }),
    mk({ id: 'pick-mt', localOnly: true }),
    mk({ id: 'ship-mo', rancherId: 'recS', rancherState: 'MO', rancherServesStates: ['MO'] }),
  ];
  assert.deepEqual(marketStripFor(rows, 'MT').map((p) => p.id), ['ship-mt', 'pick-mt']);
  // WY served by the MT ranch: shipped yes, pickup no.
  assert.deepEqual(marketStripFor(rows, 'WY').map((p) => p.id), ['ship-mt']);
  assert.deepEqual(marketStripFor(rows, 'CO'), []);
  assert.deepEqual(marketStripFor(rows, ''), []);
  assert.deepEqual(marketStripFor(rows, 'nonsense'), []);
});
