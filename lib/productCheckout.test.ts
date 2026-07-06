// lib/productCheckout.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/productCheckout.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProductCharge } from './productCheckout';

test('computeProductCharge: margin = display − base; buyer pays display; rancher nets base', () => {
  // Silverline jerky: $25 display, $21.25 base → $3.75 BHC margin
  const c = computeProductCharge({ displayCents: 2500, baseCents: 2125 });
  assert.equal(c.totalChargedCents, 2500);
  assert.equal(c.rancherNetCents, 2125);
  assert.equal(c.applicationFeeCents, 375);
});

test('computeProductCharge: snack sticks $13.59 / $11.55', () => {
  const c = computeProductCharge({ displayCents: 1359, baseCents: 1155 });
  assert.equal(c.applicationFeeCents, 204);
});

test('computeProductCharge: zero-margin (base = display) is allowed → fee 0', () => {
  const c = computeProductCharge({ displayCents: 1000, baseCents: 1000 });
  assert.equal(c.applicationFeeCents, 0);
  assert.equal(c.rancherNetCents, 1000);
});

test('computeProductCharge: rounds fractional cents', () => {
  const c = computeProductCharge({ displayCents: 999.6, baseCents: 850.2 });
  assert.equal(c.totalChargedCents, 1000);
  assert.equal(c.rancherNetCents, 850);
  assert.equal(c.applicationFeeCents, 150);
});

test('computeProductCharge: THROWS when base exceeds display (negative margin blocked)', () => {
  assert.throws(() => computeProductCharge({ displayCents: 2000, baseCents: 2500 }), /exceeds display/);
});

test('computeProductCharge: THROWS on non-positive / garbage', () => {
  assert.throws(() => computeProductCharge({ displayCents: 0, baseCents: 0 }), /invalid display/);
  assert.throws(() => computeProductCharge({ displayCents: 2500, baseCents: 0 }), /invalid rancher base/);
  assert.throws(() => computeProductCharge({ displayCents: NaN as any, baseCents: 100 }), /invalid display/);
});
