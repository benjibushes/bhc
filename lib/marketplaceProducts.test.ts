// lib/marketplaceProducts.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/marketplaceProducts.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSellableRow, hasStock, groupProducts, pickFunnelProducts, type MarketplaceProduct } from './marketplaceProducts';

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
