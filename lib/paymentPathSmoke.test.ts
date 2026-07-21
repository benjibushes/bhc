// lib/paymentPathSmoke.test.ts
//
// Static-gate tests for the go-live payment-path smoke (1c). The live
// Connect probe (runPaymentPathSmoke's tier_v2 branch) is deliberately NOT
// unit-tested — it is a network call against Stripe; the static matrix here
// covers everything pure.
// Run: JWT_SECRET=test-secret-ci npx tsx --test lib/paymentPathSmoke.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStaticGates, smokePricingModel } from './paymentPathSmoke';

function failuresOf(rancher: any): string[] {
  return evaluateStaticGates(rancher).filter((g) => !g.ok).map((g) => g.gate);
}

// ── pricing model default ───────────────────────────────────────────────────

test('unset Pricing Model defaults to legacy (matches rancherEligibility/activate)', () => {
  assert.equal(smokePricingModel({}), 'legacy');
  assert.equal(smokePricingModel({ 'Pricing Model': '' }), 'legacy');
  assert.equal(smokePricingModel({ 'Pricing Model': 'legacy' }), 'legacy');
  assert.equal(smokePricingModel({ 'Pricing Model': 'tier_v2' }), 'tier_v2');
  assert.equal(smokePricingModel({ 'Pricing Model': 'TIER_V2' }), 'tier_v2');
});

// ── legacy matrix ───────────────────────────────────────────────────────────

test('legacy complete: slug + one price + one payment link → all gates pass', () => {
  const r = {
    Slug: 'good-ranch',
    'Half Price': 1200,
    'Half Payment Link': 'https://buy.stripe.com/abc',
  };
  assert.deepEqual(failuresOf(r), []);
});

test('legacy with price but NO payment link → payment-link gate fails', () => {
  const r = { Slug: 'jc-ranch', 'Quarter Price': 800 };
  assert.deepEqual(failuresOf(r), ['payment-link']);
});

test('legacy with link but NO price → price gate fails', () => {
  const r = { Slug: 'x', 'Whole Payment Link': 'https://buy.stripe.com/xyz' };
  assert.deepEqual(failuresOf(r), ['price']);
});

test('legacy empty record → slug + price + payment-link all fail', () => {
  assert.deepEqual(failuresOf({}).sort(), ['payment-link', 'price', 'slug'].sort());
});

test('legacy: any one of the three tiers satisfies price and link (unmatched pairing allowed — mirrors activate)', () => {
  // Price on Quarter, link on Whole — the go-live rails accept this today;
  // the smoke test must not be stricter than the rails it verifies.
  const r = {
    Slug: 'split-ranch',
    'Quarter Price': 900,
    'Whole Payment Link': 'https://buy.stripe.com/whole',
  };
  assert.deepEqual(failuresOf(r), []);
});

test('zero price is not a price (truthiness match to activate hasPrice)', () => {
  const r = { Slug: 'zero', 'Quarter Price': 0, 'Quarter Payment Link': 'https://x' };
  assert.deepEqual(failuresOf(r), ['price']);
});

// ── tier_v2 matrix ──────────────────────────────────────────────────────────

test('tier_v2 complete: slug + price + connect account id → all gates pass', () => {
  const r = {
    'Pricing Model': 'tier_v2',
    Slug: 'connect-ranch',
    'Half Price': 1500,
    'Stripe Connect Account Id': 'acct_123',
  };
  assert.deepEqual(failuresOf(r), []);
});

test('tier_v2 without Connect account id → connect-account gate fails', () => {
  const r = { 'Pricing Model': 'tier_v2', Slug: 's', 'Half Price': 1500 };
  assert.deepEqual(failuresOf(r), ['connect-account']);
});

test('tier_v2 does NOT require payment links (Connect rails, not links)', () => {
  const r = {
    'Pricing Model': 'tier_v2',
    Slug: 's',
    'Quarter Price': 700,
    'Stripe Connect Account Id': 'acct_9',
  };
  const gates = evaluateStaticGates(r);
  assert.equal(gates.some((g) => g.gate === 'payment-link'), false);
  assert.deepEqual(failuresOf(r), []);
});

test('tier_v2 missing everything → slug + price + connect-account fail', () => {
  const r = { 'Pricing Model': 'tier_v2' };
  assert.deepEqual(failuresOf(r).sort(), ['connect-account', 'price', 'slug'].sort());
});

// ── shape/robustness ────────────────────────────────────────────────────────

test('whitespace-only slug / account id fail their gates', () => {
  const r = {
    'Pricing Model': 'tier_v2',
    Slug: '   ',
    'Half Price': 1,
    'Stripe Connect Account Id': '  ',
  };
  assert.deepEqual(failuresOf(r).sort(), ['connect-account', 'slug'].sort());
});

test('every gate result carries a non-empty detail string', () => {
  for (const g of evaluateStaticGates({})) {
    assert.equal(typeof g.detail, 'string');
    assert.ok(g.detail.length > 0);
  }
});

test('null/undefined rancher does not throw — all gates fail', () => {
  assert.ok(failuresOf(null).length >= 3);
  assert.ok(failuresOf(undefined).length >= 3);
});
