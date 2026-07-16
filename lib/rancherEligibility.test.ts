// Wave C (2026-07-14) — pin the closed-account rejection. Self-serve closure
// sets Verification Status='Removed' + Active Status='Paused'; a one-click
// Resume used to flip Active Status back and re-open buyer routing for an
// account whose public page 404s. isRancherOperationalForBuyers must reject
// Removed no matter what the other gates say.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRancherOperationalForBuyers, isRancherOnConnect } from './rancherEligibility';

// A fully-operational legacy rancher — passes every gate.
function operationalRancher(over: Record<string, unknown> = {}) {
  return {
    'Active Status': 'Active',
    'Onboarding Status': 'Live',
    'Agreement Signed': true,
    'Subscription Status': 'active',
    'Pricing Model': 'legacy',
    ...over,
  };
}

test('baseline: a fully-operational rancher passes', () => {
  assert.equal(isRancherOperationalForBuyers(operationalRancher()), true);
});

test('Verification Status=Removed rejects even when every other gate passes', () => {
  assert.equal(
    isRancherOperationalForBuyers(operationalRancher({ 'Verification Status': 'Removed' })),
    false,
  );
});

test('Removed rejects in Airtable enum-object shape too', () => {
  assert.equal(
    isRancherOperationalForBuyers(
      operationalRancher({ 'Verification Status': { name: 'Removed' } }),
    ),
    false,
  );
});

test('other Verification Status values do not gate', () => {
  assert.equal(
    isRancherOperationalForBuyers(operationalRancher({ 'Verification Status': 'Verified' })),
    true,
  );
  assert.equal(
    isRancherOperationalForBuyers(operationalRancher({ 'Verification Status': '' })),
    true,
  );
});

// ─── isRancherOnConnect — the deposit-CTA mint gate (2026-07-15) ────────────
// Every buyer-facing deposit-link mint (intro emails, telegram approves,
// resend-intro, bulk routes, Pending-Approval promotion) must gate on this —
// Pricing Model alone mints links that hard-409 at checkout/deposit when
// Connect onboarding never finished.

test('isRancherOnConnect: tier_v2 + Connect active → true', () => {
  assert.equal(
    isRancherOnConnect({ 'Pricing Model': 'tier_v2', 'Stripe Connect Status': 'active' }),
    true,
  );
});

test('isRancherOnConnect: tier_v2 but Connect not active → false (dead-CTA guard)', () => {
  assert.equal(
    isRancherOnConnect({ 'Pricing Model': 'tier_v2', 'Stripe Connect Status': 'onboarding' }),
    false,
  );
  assert.equal(isRancherOnConnect({ 'Pricing Model': 'tier_v2' }), false);
});

test('isRancherOnConnect: legacy rancher → false regardless of Connect status', () => {
  assert.equal(
    isRancherOnConnect({ 'Pricing Model': 'legacy', 'Stripe Connect Status': 'active' }),
    false,
  );
});

test('isRancherOnConnect: case-insensitive on both fields', () => {
  assert.equal(
    isRancherOnConnect({ 'Pricing Model': 'Tier_V2', 'Stripe Connect Status': 'Active' }),
    true,
  );
});
