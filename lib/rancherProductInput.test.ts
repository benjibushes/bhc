// Tests for lib/rancherProductInput.ts — the pure pricing + validation layer
// behind the rancher self-serve product rail (journey overhaul Phase 6).
//
// The load-bearing invariant mirrors isSellableRow in lib/marketplaceProducts:
// derived Rancher Base must always satisfy 0 < base <= display, so a
// self-served product can never mint a negative-margin (or free) row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveProductPricing,
  validateProductInput,
  MARGIN_BY_CATEGORY,
  PRODUCT_CATEGORIES,
  MIN_PRODUCT_PRICE_CENTS,
} from './rancherProductInput';

// ── deriveProductPricing ──────────────────────────────────────────────────────

test('jerky takes the 20% impulse margin', () => {
  const p = deriveProductPricing({ displayCents: 2000, category: 'Jerky' });
  assert.equal(p.displayCents, 2000);
  assert.equal(p.marginRate, 0.2);
  assert.equal(p.baseCents, 1600);
  assert.equal(p.marginCents, 400);
});

test('snack sticks take the 20% impulse margin', () => {
  const p = deriveProductPricing({ displayCents: 1359, category: 'Snack Sticks' });
  assert.equal(p.marginRate, 0.2);
  assert.equal(p.baseCents + p.marginCents, 1359); // cents always reconcile
});

test('boxes take 15%', () => {
  for (const category of ['Sampler Box', 'Bundle', 'Ground Box', 'Eighth Share']) {
    const p = deriveProductPricing({ displayCents: 9500, category });
    assert.equal(p.marginRate, 0.15, category);
    assert.equal(p.baseCents, 8075, category);
  }
});

test('unknown category falls back to the 15% default', () => {
  const p = deriveProductPricing({ displayCents: 10000, category: 'Mystery' });
  assert.equal(p.marginRate, 0.15);
});

test('sellability invariant holds at awkward cent values', () => {
  // Sweep odd prices — base must always be 0 < base <= display and reconcile.
  for (const displayCents of [501, 999, 1001, 1359, 2499, 74900, 33333]) {
    for (const category of PRODUCT_CATEGORIES) {
      const p = deriveProductPricing({ displayCents, category });
      assert.ok(p.baseCents > 0, `${category} ${displayCents}: base > 0`);
      assert.ok(p.baseCents <= p.displayCents, `${category} ${displayCents}: base <= display`);
      assert.equal(p.baseCents + p.marginCents, p.displayCents, 'cents reconcile');
    }
  }
});

// ── validateProductInput ──────────────────────────────────────────────────────

const GOOD = {
  name: 'Peppered Beef Jerky',
  displayPrice: 19.99,
  category: 'Jerky',
  description: 'a bag of the good stuff',
  weight: '3 oz',
  imageUrl: 'https://blob.vercel-storage.com/ranchers/rec123/x-photo.jpg',
  shipsNationwide: true,
  shelfStable: true,
};

test('a valid input normalizes into Airtable-ready fields', () => {
  const r = validateProductInput(GOOD);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fields['Product Name'], 'Peppered Beef Jerky');
  assert.equal(r.fields['Display Price'], 19.99);
  assert.equal(r.fields['Category'], 'Jerky');
  assert.equal(r.fields['Ships Nationwide'], true);
  assert.equal(r.fields['Shelf Stable'], true);
  assert.equal(r.displayCents, 1999);
});

test('name is required and length-capped', () => {
  assert.equal(validateProductInput({ ...GOOD, name: '' }).ok, false);
  assert.equal(validateProductInput({ ...GOOD, name: 'x'.repeat(81) }).ok, false);
});

test('price floor enforced', () => {
  assert.equal(MIN_PRODUCT_PRICE_CENTS, 500);
  assert.equal(validateProductInput({ ...GOOD, displayPrice: 4.99 }).ok, false);
  assert.equal(validateProductInput({ ...GOOD, displayPrice: 0 }).ok, false);
  assert.equal(validateProductInput({ ...GOOD, displayPrice: NaN as any }).ok, false);
});

test('category must be one of the canonical marketplace categories', () => {
  assert.equal(validateProductInput({ ...GOOD, category: 'Weird Stuff' }).ok, false);
  for (const category of PRODUCT_CATEGORIES) {
    assert.equal(validateProductInput({ ...GOOD, category }).ok, true, category);
  }
});

test('cloud-share image links are rejected (Drive/Dropbox render broken)', () => {
  for (const bad of [
    'https://drive.google.com/file/d/abc/view',
    'https://www.dropbox.com/s/abc/photo.jpg',
    'https://1drv.ms/u/s!abc',
    'not-a-url',
  ]) {
    assert.equal(validateProductInput({ ...GOOD, imageUrl: bad }).ok, false, bad);
  }
});

test('image is optional — a product can launch photo-less (placeholder renders)', () => {
  const r = validateProductInput({ ...GOOD, imageUrl: '' });
  assert.equal(r.ok, true);
});

test('description capped at 1000, weight at 60', () => {
  assert.equal(validateProductInput({ ...GOOD, description: 'x'.repeat(1001) }).ok, false);
  assert.equal(validateProductInput({ ...GOOD, weight: 'x'.repeat(61) }).ok, false);
});

test('shipsNationwide defaults true; explicit false respected', () => {
  const def = validateProductInput({ ...GOOD, shipsNationwide: undefined as any });
  assert.equal(def.ok && def.fields['Ships Nationwide'], true);
  const off = validateProductInput({ ...GOOD, shipsNationwide: false });
  assert.equal(off.ok && off.fields['Ships Nationwide'], false);
});

test('margin map covers every canonical category', () => {
  for (const c of PRODUCT_CATEGORIES) {
    assert.ok(MARGIN_BY_CATEGORY[c] !== undefined, c);
  }
});

test('ordersLeft: blank = unlimited (null field), integers pass, junk rejected', () => {
  const blank = validateProductInput({ ...GOOD });
  assert.equal(blank.ok && blank.fields['Orders Left'], null);
  const set = validateProductInput({ ...GOOD, ordersLeft: 12 });
  assert.equal(set.ok && set.fields['Orders Left'], 12);
  const zero = validateProductInput({ ...GOOD, ordersLeft: 0 });
  assert.equal(zero.ok && zero.fields['Orders Left'], 0); // deliberate sold-out pause
  assert.equal(validateProductInput({ ...GOOD, ordersLeft: 2.5 as any }).ok, false);
  assert.equal(validateProductInput({ ...GOOD, ordersLeft: -1 as any }).ok, false);
});
