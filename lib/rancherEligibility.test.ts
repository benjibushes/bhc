// Wave C (2026-07-14) — pin the closed-account rejection. Self-serve closure
// sets Verification Status='Removed' + Active Status='Paused'; a one-click
// Resume used to flip Active Status back and re-open buyer routing for an
// account whose public page 404s. isRancherOperationalForBuyers must reject
// Removed no matter what the other gates say.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRancherOperationalForBuyers } from './rancherEligibility';

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
