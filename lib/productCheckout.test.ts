// lib/productCheckout.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/productCheckout.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProductCharge, createProductCheckout, buildProductMetadata } from './productCheckout';

test('computeProductCharge: fee = gross margin − processing estimate (net-your-number)', () => {
  // Silverline jerky: $25 display, $21.25 base → $3.75 gross margin;
  // est fee on $25 = 73+30 = 103¢ → app fee 272¢, absorption 103¢
  const c = computeProductCharge({ displayCents: 2500, baseCents: 2125 });
  assert.equal(c.totalChargedCents, 2500);
  assert.equal(c.rancherNetCents, 2125);
  assert.equal(c.grossMarginCents, 375);
  assert.equal(c.applicationFeeCents, 375 - (Math.round(2500 * 0.029) + 30));
  assert.equal(c.applicationFeeCents + c.absorbedCents, 375);
});

test('computeProductCharge: snack sticks $13.59 / $11.55 — small ticket floors at $1', () => {
  const c = computeProductCharge({ displayCents: 1359, baseCents: 1155 });
  assert.equal(c.grossMarginCents, 204);
  // est = 39+30 = 69 → 204-69 = 135, above the $1 floor
  assert.equal(c.applicationFeeCents, 135);
  assert.equal(c.absorbedCents, 69);
});

test('computeProductCharge: zero-margin (base = display) is allowed → fee 0, nothing to absorb', () => {
  const c = computeProductCharge({ displayCents: 1000, baseCents: 1000 });
  assert.equal(c.applicationFeeCents, 0);
  assert.equal(c.absorbedCents, 0);
  assert.equal(c.rancherNetCents, 1000);
});

test('computeProductCharge: rounds fractional cents', () => {
  const c = computeProductCharge({ displayCents: 999.6, baseCents: 850.2 });
  assert.equal(c.totalChargedCents, 1000);
  assert.equal(c.rancherNetCents, 850);
  assert.equal(c.grossMarginCents, 150);
  // est on $10 = 29+30 = 59 → 91; floor min(150, max(100, 20)) = 100 → 91<100? no: max(100, 150-59=91) = 100
  assert.equal(c.applicationFeeCents, 100);
  assert.equal(c.absorbedCents, 50);
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
  assert.equal(c.grossMarginCents, 500);
  assert.equal(c.applicationFeeCents, 500 - (Math.round(2500 * 0.029) + 30));
  assert.equal(c.rancherNetCents, 2000);
  assert.equal(c.shippingCents, 0);
});

test('computeProductCharge: shipping raises buyer total + rancher net — gross margin never touches shipping, but absorption covers processing on the FULL charge', () => {
  const c = computeProductCharge({ displayCents: 2500, baseCents: 2000, shippingCents: 1200 });
  assert.equal(c.totalChargedCents, 3700);   // buyer pays product + shipping
  assert.equal(c.grossMarginCents, 500);     // margin NEVER touches shipping
  // absorption est on the full $37 charge = 107+30 = 137
  assert.equal(c.applicationFeeCents, 500 - 137);
  assert.equal(c.rancherNetCents, 3200);     // rancher keeps 100% of shipping
  assert.equal(c.shippingCents, 1200);
});

test('computeProductCharge: negative or junk shipping is rejected', () => {
  assert.throws(() => computeProductCharge({ displayCents: 2500, baseCents: 2000, shippingCents: -1 }), /invalid shipping/);
  assert.throws(() => computeProductCharge({ displayCents: 2500, baseCents: 2000, shippingCents: NaN }), /invalid shipping/);
});

// ── quantity (2026-07-07) ────────────────────────────────────────────────────

test('computeProductCharge: quantity scales product + fee; shipping stays flat per order', () => {
  const c = computeProductCharge({ displayCents: 2500, baseCents: 2000, shippingCents: 1200, quantity: 3 });
  assert.equal(c.totalChargedCents, 2500 * 3 + 1200);
  assert.equal(c.grossMarginCents, 500 * 3);
  // absorption est on the full $87 charge = 252+30 = 282
  assert.equal(c.applicationFeeCents, 500 * 3 - 282);
  assert.equal(c.absorbedCents, 282);
  assert.equal(c.rancherNetCents, 2000 * 3 + 1200);
  assert.equal(c.quantity, 3);
});

test('computeProductCharge: quantity defaults to 1 and rejects junk / 0 / >10', () => {
  assert.equal(computeProductCharge({ displayCents: 2500, baseCents: 2000 }).quantity, 1);
  assert.throws(() => computeProductCharge({ displayCents: 2500, baseCents: 2000, quantity: 0 }), /invalid quantity/);
  assert.throws(() => computeProductCharge({ displayCents: 2500, baseCents: 2000, quantity: 11 }), /invalid quantity/);
  assert.throws(() => computeProductCharge({ displayCents: 2500, baseCents: 2000, quantity: NaN }), /invalid quantity/);
});

// ── metadata parity contract (Payment Element migration, spec R2) ────────────
// settleProductPurchase reads ONLY these keys. Both mint paths (Checkout
// Session + raw PaymentIntent) share buildProductMetadata, so this snapshot IS
// the zero-settlement-change contract. If this test breaks, settlement's
// expectations changed — update lib/productSettlement.ts in the SAME PR.

test('buildProductMetadata: exact settlement key set + string values', () => {
  const charge = computeProductCharge({ displayCents: 2500, baseCents: 2000, shippingCents: 1200, quantity: 2 });
  const md = buildProductMetadata(
    {
      productId: 'recAAAAAAAAAAAAAA', productName: 'Jerky', rancherId: 'recBBBBBBBBBBBBBB',
      rancherName: 'Ranch X', buyerEmail: 'buyer@x.com', buyerName: '',
      displayCents: 2500, baseCents: 2000, depositStyle: false,
    },
    charge,
  );
  assert.deepEqual(Object.keys(md).sort(), [
    'absorbedStripeFeeCents', 'baseCents', 'buyerEmail', 'buyerName',
    'depositStyle', 'displayCents', 'fulfillment', 'grossMarginCents',
    'marginCents', 'productId', 'productName', 'quantity',
    'rancherId', 'rancherName', 'shippingCents', 'type',
  ]);
  assert.equal(md.type, 'product_purchase');
  assert.equal(md.displayCents, '2500');   // UNIT price, not total
  assert.equal(md.baseCents, '2000');      // UNIT base
  // marginCents = the fee actually charged (net of absorption); gross kept
  // separately. $62 charge → est 210¢ → 1000 − 210 = 790.
  assert.equal(md.grossMarginCents, '1000'); // (display−base)×qty
  assert.equal(md.marginCents, '790');
  assert.equal(md.absorbedStripeFeeCents, '210');
  assert.equal(md.shippingCents, '1200');  // flat per order
  assert.equal(md.quantity, '2');
  assert.equal(md.depositStyle, 'false');
  assert.equal(md.fulfillment, 'ship');   // default; localOnly:true → 'pickup' (settlement branches on it)
  for (const v of Object.values(md)) assert.equal(typeof v, 'string');
});

test('buildProductMetadata: localOnly stamps fulfillment=pickup', () => {
  const charge = computeProductCharge({ displayCents: 2500, baseCents: 2000 });
  const md = buildProductMetadata(
    {
      productId: 'recAAAAAAAAAAAAAA', productName: 'Jerky', rancherId: 'recBBBBBBBBBBBBBB',
      rancherName: 'Ranch X', buyerEmail: '', buyerName: '',
      displayCents: 2500, baseCents: 2000, depositStyle: false, localOnly: true,
    },
    charge,
  );
  assert.equal(md.fulfillment, 'pickup');
});
