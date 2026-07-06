// lib/marketplaceProducts.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/marketplaceProducts.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSellableRow, groupProducts, type MarketplaceProduct } from './marketplaceProducts';

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
  depositStyle: false, priceRange: '',
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
