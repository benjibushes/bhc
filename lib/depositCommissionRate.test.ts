// lib/depositCommissionRate.test.ts
//
// GO-LIVE MONEY HARDENING finding 1 (2026-07-02) — deposit application_fee
// must honor the rancher's LOCKED Commission Rate.
//
// THE BUG: app/api/checkout/deposit computed platformFeeCents from
// TIERS[tier].commissionRate alone — the tier CONSTANT — while the rancher
// billing page displays the locked `Commission Rate` field (the mandated
// rate source since the Ashcraft 2026-05-20 dispute) and the
// tier-subscription webhook deliberately preserves locked rates over tier
// defaults. Result: a negotiated-rate rancher's buyers were charged the tier
// constant while the dashboard showed the negotiated rate. displayed ≠ charged.
//
// depositCommissionRate(rancher, tier) is the ONE pure decision every deposit
// fee computation (charge + display) must route through:
//   locked rate usable (normalizeCommissionRate ≠ null) → the locked rate
//   (0 is a VALID locked rate — Operator-tier zero commission)
//   else → the tier constant (commissionRateForTier: TIERS[tier], or the
//   env-default legacy fallback when tier is null — byte-identical to the
//   pre-fix behavior for every rancher with no locked rate)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depositCommissionRate, commissionPercentLabelForRancher, TIERS } from './tiers';

test('locked 0.04 beats the Pasture tier constant (0.07)', () => {
  assert.equal(depositCommissionRate({ 'Commission Rate': 0.04 }, 'pasture'), 0.04);
  // Sanity-pin the constant so this test screams if the tier table moves.
  assert.equal(TIERS.pasture.commissionRate, 0.07);
});

test('locked 0 (negotiated zero commission) → 0 fee, never the tier constant', () => {
  assert.equal(depositCommissionRate({ 'Commission Rate': 0 }, 'pasture'), 0);
  assert.equal(depositCommissionRate({ 'Commission Rate': 0 }, 'legacy_connect'), 0);
  // Operator tier is 0% anyway — locked 0 and constant agree.
  assert.equal(depositCommissionRate({ 'Commission Rate': 0 }, 'operator'), 0);
});

test('empty / missing / garbage field → tier constant (pre-fix behavior preserved)', () => {
  assert.equal(depositCommissionRate({}, 'pasture'), 0.07);
  assert.equal(depositCommissionRate({ 'Commission Rate': '' }, 'ranch'), 0.03);
  assert.equal(depositCommissionRate({ 'Commission Rate': null }, 'legacy_connect'), 0.10);
  assert.equal(depositCommissionRate({ 'Commission Rate': 'abc' }, 'pasture'), 0.07);
  // Negative + implausible (≥100) are garbage per normalizeCommissionRate —
  // never guess with money, fall to the tier constant.
  assert.equal(depositCommissionRate({ 'Commission Rate': -0.05 }, 'ranch'), 0.03);
  assert.equal(depositCommissionRate({ 'Commission Rate': 400 }, 'pasture'), 0.07);
  // No rancher record at all (defensive) → tier constant.
  assert.equal(depositCommissionRate(null, 'operator'), 0);
  assert.equal(depositCommissionRate(undefined, 'pasture'), 0.07);
});

test('percent-typed locked rate normalizes: 4 → 0.04, "4%" → 0.04', () => {
  assert.equal(depositCommissionRate({ 'Commission Rate': 4 }, 'pasture'), 0.04);
  assert.equal(depositCommissionRate({ 'Commission Rate': '4%' }, 'ranch'), 0.04);
  assert.equal(depositCommissionRate({ 'Commission Rate': '0.04' }, 'legacy_connect'), 0.04);
});

test('null tier: locked rate still wins; no locked rate → legacy env-default fallback', () => {
  assert.equal(depositCommissionRate({ 'Commission Rate': 0.05 }, null), 0.05);
  const prev = process.env.COMMISSION_RATE_DEFAULT;
  delete process.env.COMMISSION_RATE_DEFAULT;
  try {
    // Matches commissionRateForTier(null) — the exact fallback the display
    // surfaces used pre-fix.
    assert.equal(depositCommissionRate({}, null), 0.10);
  } finally {
    if (prev !== undefined) process.env.COMMISSION_RATE_DEFAULT = prev;
  }
});

// ── commissionPercentLabelForRancher (comms containment 2026-08-18) ─────────
// The telegram rancher-email footers said "10% commission" for EVERY rancher
// the broker gates let through — tier-blind. The label must always render the
// rate the charge path would use (same precedence as depositCommissionRate),
// so the footer can never quote a rate the invoice would contradict.

test('commissionPercentLabelForRancher: label = the rate the charge path would use', () => {
  assert.equal(commissionPercentLabelForRancher({}), '10%'); // legacy env default
  assert.equal(commissionPercentLabelForRancher({ Tier: 'Pasture' }), '7%');
  assert.equal(commissionPercentLabelForRancher({ Tier: 'Ranch' }), '3%');
  assert.equal(commissionPercentLabelForRancher({ Tier: 'Operator' }), '0%');
  assert.equal(commissionPercentLabelForRancher({ Tier: 'Legacy Connect' }), '10%');
  // Locked rate beats the tier constant — including a locked 0 (valid).
  assert.equal(commissionPercentLabelForRancher({ 'Commission Rate': 0.035 }), '3.5%');
  assert.equal(commissionPercentLabelForRancher({ Tier: 'Pasture', 'Commission Rate': 0 }), '0%');
  // Airtable singleSelect object shape parses too.
  assert.equal(commissionPercentLabelForRancher({ Tier: { name: 'Ranch' } }), '3%');
});
