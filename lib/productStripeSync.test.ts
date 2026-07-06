// lib/productStripeSync.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/productStripeSync.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePriceAction } from './productStripeSync';

test('reuse when stored price cents match display + ids present', () => {
  const d = resolvePriceAction({ existingProductId: 'prod_1', existingPriceId: 'price_1', existingPriceCents: 2500, displayCents: 2500 });
  assert.equal(d.reusePrice, true);
  assert.equal(d.reuseProduct, true);
});

test('new price when display changed (immutable Price) but product reused', () => {
  const d = resolvePriceAction({ existingProductId: 'prod_1', existingPriceId: 'price_1', existingPriceCents: 2500, displayCents: 2900 });
  assert.equal(d.reusePrice, false);
  assert.equal(d.reuseProduct, true);
});

test('first-ever sell: no ids yet → mint both', () => {
  const d = resolvePriceAction({ displayCents: 1359 });
  assert.equal(d.reusePrice, false);
  assert.equal(d.reuseProduct, false);
});

test('product exists but no price yet → keep product, mint price', () => {
  const d = resolvePriceAction({ existingProductId: 'prod_1', displayCents: 9500 });
  assert.equal(d.reusePrice, false);
  assert.equal(d.reuseProduct, true);
});

test('price id present but cents missing/mismatched → new price', () => {
  assert.equal(resolvePriceAction({ existingProductId: 'p', existingPriceId: 'pr', displayCents: 2500 }).reusePrice, false);
  assert.equal(resolvePriceAction({ existingProductId: 'p', existingPriceId: 'pr', existingPriceCents: 0, displayCents: 2500 }).reusePrice, false);
});

test('never reuse a zero/garbage display', () => {
  assert.equal(resolvePriceAction({ existingProductId: 'p', existingPriceId: 'pr', existingPriceCents: 0, displayCents: 0 }).reusePrice, false);
});
