import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rancherCanTakeProductCharge, chargedShippingDollars } from './storefrontGates';

// ─── rancherCanTakeProductCharge — the PDP Buy-button gate (L12) ────────────
// Must agree byte-for-byte with lib/productBuyGates.ts's Connect clause, so a
// product page never renders a Buy button the charge route then 409s.

test('Connect active + account id present → takeable', () => {
  assert.equal(
    rancherCanTakeProductCharge({
      'Stripe Connect Status': 'active',
      'Stripe Connect Account Id': 'acct_123',
    }),
    true,
  );
});

test('Connect NOT active → not takeable (the L12 dead-end)', () => {
  // Onboarding-but-not-finished is exactly the reported failure: the PDP
  // rendered Buy, the buyer proceeded, checkout hard-rejected.
  for (const status of ['onboarding', 'pending', 'restricted', '']) {
    assert.equal(
      rancherCanTakeProductCharge({
        'Stripe Connect Status': status,
        'Stripe Connect Account Id': 'acct_123',
      }),
      false,
    );
  }
});

test('active status but MISSING account id → not takeable', () => {
  // productBuyGates 409s when the account id is blank even if status says
  // active — mirror that so the page agrees.
  assert.equal(
    rancherCanTakeProductCharge({ 'Stripe Connect Status': 'active', 'Stripe Connect Account Id': '' }),
    false,
  );
  assert.equal(
    rancherCanTakeProductCharge({ 'Stripe Connect Status': 'active', 'Stripe Connect Account Id': '   ' }),
    false,
  );
  assert.equal(rancherCanTakeProductCharge({ 'Stripe Connect Status': 'active' }), false);
});

test('case-SENSITIVE on status — mirrors the gate (capital Active fails)', () => {
  // productBuyGates compares `!== 'active'` with no lowercasing. If we treated
  // 'Active' as takeable, the page would show Buy but the gate would 409 —
  // exactly the drift this parity is meant to prevent.
  assert.equal(
    rancherCanTakeProductCharge({ 'Stripe Connect Status': 'Active', 'Stripe Connect Account Id': 'acct_1' }),
    false,
  );
});

test('null / undefined rancher → not takeable (no throw)', () => {
  assert.equal(rancherCanTakeProductCharge(null), false);
  assert.equal(rancherCanTakeProductCharge(undefined), false);
});

// ─── chargedShippingDollars — the checkout summary shipping term (L13) ───────
// Must equal the shipping productBuyGates / the Payment Element actually charge.

test('nationwide fixed-price product → charges the shipping passthrough', () => {
  assert.equal(chargedShippingDollars({ depositStyle: false, localOnly: false, shippingCost: 12.5 }), 12.5);
});

test('local-pickup product → shipping forced to 0 (the L13 bug)', () => {
  // A pickup product carrying a Shipping Cost must NOT add it — the card is
  // charged $0 shipping, so the summary must show $0 shipping too.
  assert.equal(chargedShippingDollars({ depositStyle: false, localOnly: true, shippingCost: 20 }), 0);
});

test('deposit-style product → shipping forced to 0 (settles with the balance)', () => {
  assert.equal(chargedShippingDollars({ depositStyle: true, localOnly: false, shippingCost: 15 }), 0);
});

test('negative / junk Shipping Cost clamps to 0', () => {
  assert.equal(chargedShippingDollars({ depositStyle: false, localOnly: false, shippingCost: -5 }), 0);
  assert.equal(chargedShippingDollars({ depositStyle: false, localOnly: false, shippingCost: NaN }), 0);
});

test('no shipping cost → 0', () => {
  assert.equal(chargedShippingDollars({ depositStyle: false, localOnly: false, shippingCost: 0 }), 0);
});
