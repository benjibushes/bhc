// lib/marketplaceProducts.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/marketplaceProducts.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSellableRow, isLocalPickupRow, hasStock, groupProducts, pickFunnelProducts, productsForRancher, localMarketFor, type MarketplaceProduct } from './marketplaceProducts';

const ok = { 'Active': true, 'Ships Nationwide': true, 'Display Price': 25, 'Rancher Base': 21.25 };

test('isSellableRow: a live, priced, nationwide row is sellable', () => {
  assert.equal(isSellableRow(ok), true);
});

test('isSellableRow: blank Ships Nationwide still sells (safe default — only explicit false hides)', () => {
  assert.equal(isSellableRow({ ...ok, 'Ships Nationwide': undefined }), true);
  assert.equal(isSellableRow({ ...ok, 'Ships Nationwide': false }), false);
});

test('isSellableRow: inactive is never sellable', () => {
  assert.equal(isSellableRow({ ...ok, 'Active': false }), false);
  assert.equal(isSellableRow({ ...ok, 'Active': undefined }), false);
});

test('isSellableRow: MONEY INVARIANT — base > display (negative margin) is never sellable', () => {
  assert.equal(isSellableRow({ ...ok, 'Rancher Base': 30 }), false); // base 30 > display 25
});

test('isSellableRow: missing price or base is never sellable', () => {
  assert.equal(isSellableRow({ ...ok, 'Display Price': 0 }), false);
  assert.equal(isSellableRow({ ...ok, 'Rancher Base': 0 }), false);
});

const mk = (id: string, category: string): MarketplaceProduct => ({
  id, name: id, rancher: 'R', category, tier: '', price: 10, base: 8, weight: '', shelfStable: false, image: '', description: '',
  depositStyle: false, priceRange: '', ordersLeft: null,
  whatsIncluded: '', shipsInDays: null, packaging: '', feeds: '',
  rancherId: '', shippingCost: 0, localOnly: false, rancherState: '', externalCheckoutUrl: '', rancherConnectActive: true,
  rancherServesStates: [], rancherSlug: '', rancherPhoto: '',
});

test('groupProducts: collapses categories into display groups, in order', () => {
  const groups = groupProducts([
    mk('a', 'Jerky'), mk('b', 'Snack Sticks'), mk('c', 'Sampler Box'), mk('d', 'Ground Box'), mk('e', 'Eighth Share'),
  ]);
  assert.deepEqual(groups.map((g) => g.key), ['jerky', 'boxes', 'ground', 'shares']);
  assert.equal(groups[0].items.length, 2); // Jerky + Snack Sticks → "jerky & snack sticks"
});

test('groupProducts: unmapped category falls through to "more" (never dropped)', () => {
  const groups = groupProducts([mk('x', 'Mystery Meat')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'more');
  assert.equal(groups[0].items[0].id, 'x');
});

test('groupProducts: empty input → no groups', () => {
  assert.deepEqual(groupProducts([]), []);
});

// ── pickFunnelProducts (Phase 8 — the reveal's low-ticket rail) ───────────────

test('pickFunnelProducts: one per non-share group, cheapest first, shares excluded', () => {
  const picks = pickFunnelProducts([
    mk('jerky-cheap', 'Jerky'), mk('jerky-2', 'Jerky'), mk('box', 'Sampler Box'),
    mk('ground', 'Ground Box'), mk('share', 'Eighth Share'),
  ]);
  assert.deepEqual(picks.map((p) => p.id), ['jerky-cheap', 'box', 'ground']);
});

test('pickFunnelProducts: backfills from non-share products when a group is empty', () => {
  const picks = pickFunnelProducts([
    mk('j1', 'Jerky'), mk('j2', 'Jerky'), mk('share', 'Eighth Share'),
  ]);
  assert.deepEqual(picks.map((p) => p.id), ['j1', 'j2']); // share never backfills
});

test('pickFunnelProducts: caps at 3 and never picks a share even when sparse', () => {
  const picks = pickFunnelProducts([mk('share', 'Eighth Share')]);
  assert.deepEqual(picks, []);
});

// ── inventory gate (Phase 11 — ad-readiness) ──────────────────────────────────

test('isSellableRow: blank Orders Left = unlimited (pre-inventory rows keep selling)', () => {
  assert.equal(isSellableRow({ ...ok }), true);
  assert.equal(isSellableRow({ ...ok, 'Orders Left': null }), true);
  assert.equal(isSellableRow({ ...ok, 'Orders Left': '' }), true);
});

test('isSellableRow: positive stock sells, zero/negative is sold out', () => {
  assert.equal(isSellableRow({ ...ok, 'Orders Left': 12 }), true);
  assert.equal(isSellableRow({ ...ok, 'Orders Left': 1 }), true);
  assert.equal(isSellableRow({ ...ok, 'Orders Left': 0 }), false);
  assert.equal(isSellableRow({ ...ok, 'Orders Left': -3 }), false);
});

test('hasStock mirrors the inventory clause exactly', () => {
  assert.equal(hasStock({}), true);
  assert.equal(hasStock({ 'Orders Left': 5 }), true);
  assert.equal(hasStock({ 'Orders Left': 0 }), false);
});

test('productsForRancher: returns only that rancher\'s products; blank id returns none', () => {
  const a = { ...mk('a', 'Jerky'), rancherId: 'recAAAAAAAAAAAAAA' };
  const b = { ...mk('b', 'Jerky'), rancherId: 'recBBBBBBBBBBBBBB' };
  const orphan = mk('c', 'Jerky'); // legacy row with no owner key
  assert.deepEqual(productsForRancher([a, b, orphan], 'recAAAAAAAAAAAAAA').map((p) => p.id), ['a']);
  assert.deepEqual(productsForRancher([a, b, orphan], ''), []);
  // An orphan row must never leak onto some rancher's page via '' === '' matching.
  assert.deepEqual(productsForRancher([orphan], ''), []);
});

// ── local pickup (2026-07-07) ────────────────────────────────────────────────

test('localMarketFor: matches buyer state to pickup products, never cross-state', () => {
  const txLocal = { ...mk('tx1', 'Jerky'), localOnly: true, rancherState: 'TX' };
  const mtLocal = { ...mk('mt1', 'Jerky'), localOnly: true, rancherState: 'MT' };
  const txShipped = { ...mk('tx2', 'Jerky'), localOnly: false, rancherState: 'TX' };
  const orphanLocal = { ...mk('o1', 'Jerky'), localOnly: true, rancherState: '' };
  const all = [txLocal, mtLocal, txShipped, orphanLocal];
  // exact match only — shipped products and other states stay out
  assert.deepEqual(localMarketFor(all, 'TX').map((p) => p.id), ['tx1']);
  // full state names normalize
  assert.deepEqual(localMarketFor(all, 'Texas').map((p) => p.id), ['tx1']);
  // unknown buyer state → nothing (never guess)
  assert.deepEqual(localMarketFor(all, ''), []);
  assert.deepEqual(localMarketFor(all, 'garbage'), []);
  // a local product with unknown ranch state can never surface ('' === '' guard)
  assert.deepEqual(localMarketFor([orphanLocal], ''), []);
});

test('isLocalPickupRow: EXPLICIT Ships Nationwide=false + all money/stock gates', () => {
  const local = { 'Active': true, 'Ships Nationwide': false, 'Display Price': 25, 'Rancher Base': 21.25 };
  assert.equal(isLocalPickupRow(local), true);
  assert.equal(isSellableRow(local), false);            // never on /shop or the feed
  assert.equal(isLocalPickupRow({ ...local, 'Ships Nationwide': true }), false);
  assert.equal(isLocalPickupRow({ ...local, 'Ships Nationwide': undefined }), false); // blank = nationwide, not local
  assert.equal(isLocalPickupRow({ ...local, 'Active': false }), false);   // Active is the delist switch
  assert.equal(isLocalPickupRow({ ...local, 'Orders Left': 0 }), false);  // sold out still gates
  assert.equal(isLocalPickupRow({ ...local, 'Rancher Base': 30 }), false); // money invariant still holds
});
