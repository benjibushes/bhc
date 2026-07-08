// lib/productCheckout.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/productCheckout.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProductCharge, createProductCheckout } from './productCheckout';

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

// --- WHITELABEL mode/URL guards (fire before any Stripe call) ---

const baseInput = {
  rancherConnectAccountId: 'acct_test',
  productName: 'Original Beef Jerky',
  displayCents: 2500,
  baseCents: 2125,
  productId: 'recAAAAAAAAAAAAAA',
  rancherId: 'recBBBBBBBBBBBBBB',
  rancherName: 'Test Ranch',
};

test('createProductCheckout: embedded mode requires a returnUrl (throws before Stripe)', async () => {
  await assert.rejects(
    createProductCheckout({ ...baseInput, mode: 'embedded', successUrl: 'https://x/s', cancelUrl: 'https://x/c' }),
    /embedded checkout requires a returnUrl/,
  );
});

test('createProductCheckout: hosted mode requires success + cancel URLs (throws before Stripe)', async () => {
  await assert.rejects(
    createProductCheckout({ ...baseInput, mode: 'hosted' }),
    /hosted checkout requires successUrl and cancelUrl/,
  );
});

test('createProductCheckout: default (no mode) is hosted and still requires success + cancel', async () => {
  await assert.rejects(
    createProductCheckout({ ...baseInput }),
    /hosted checkout requires successUrl and cancelUrl/,
  );
});

test('createProductCheckout: bad money is rejected regardless of mode', async () => {
  await assert.rejects(
    createProductCheckout({ ...baseInput, baseCents: 9999, mode: 'embedded', returnUrl: 'https://x/r' }),
    /exceeds display/,
  );
});

// ── shipping passthrough (2026-07-07) ────────────────────────────────────────

test('computeProductCharge: no shipping → totals unchanged, shipping normalized to 0', () => {
  const c = computeProductCharge({ displayCents: 2500, baseCents: 2000 });
  assert.equal(c.totalChargedCents, 2500);
  assert.equal(c.applicationFeeCents, 500);
  assert.equal(c.rancherNetCents, 2000);
  assert.equal(c.shippingCents, 0);
});

test('computeProductCharge: shipping raises buyer total + rancher net by the same amount — fee untouched', () => {
  const c = computeProductCharge({ displayCents: 2500, baseCents: 2000, shippingCents: 1200 });
  assert.equal(c.totalChargedCents, 3700);   // buyer pays product + shipping
  assert.equal(c.applicationFeeCents, 500);  // BHC margin NEVER touches shipping
  assert.equal(c.rancherNetCents, 3200);     // rancher keeps 100% of shipping
  assert.equal(c.shippingCents, 1200);
});

test('computeProductCharge: negative or junk shipping is rejected', () => {
  assert.throws(() => computeProductCharge({ displayCents: 2500, baseCents: 2000, shippingCents: -1 }), /invalid shipping/);
  assert.throws(() => computeProductCharge({ displayCents: 2500, baseCents: 2000, shippingCents: NaN }), /invalid shipping/);
});
