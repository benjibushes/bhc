// SELF-SERVE BROKER RANCHES ARE ROUTABLE SUPPLY (Ben, 2026-08-17).
//
// The sibling of lib/brokerGuardrails.test.ts, which pins that a PHONE-ONLY
// represented ranch stays invisible. This file pins the exception: a ranch Ben
// opted in with `Broker Self Serve`, that has a page a buyer can actually
// reach and a cut the checkout will actually take money for, is normal supply.
//
// The bug it exists for: AZ's only ranch is represented, so AZ had zero
// routable supply, every AZ buyer fell through to the nationwide fallback, and
// they were handed to a MONTANA ranch.
//
// EVERY fixture is deliberately missing the Connect paperwork a represented
// ranch could never have (no Active Status, no Agreement Signed, no Onboarding
// Status, no Pricing Model, no Stripe anything) — if a future edit "fixes"
// broker ranches by making them satisfy the Connect gates instead, these tests
// fail. Synthetic names only — the repo is PUBLIC.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isBrokerRoutable, isBrokerRancher, isBrokerSelfServe } from './brokerRail';
import {
  isRancherOperationalForBuyers,
  getOperationalServedStates,
  hasOperationalRancherForState,
} from './rancherEligibility';

/**
 * A represented ranch exactly as one really exists: opted in, publicly
 * resolvable, all three cuts priced with explicit deposits — and NONE of the
 * Connect-rail paperwork.
 */
function selfServeBrokerRanch(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'recSELFSERVE0001',
    'Ranch Name': 'Dry Wash Cattle',
    State: 'AZ',
    Zip: '85534',
    Slug: 'dry-wash-cattle',
    'Broker Rail': true,
    'Broker Self Serve': true,
    'Quarter Price': 1100,
    'Quarter Deposit': 250,
    'Half Price': 2100,
    'Half Deposit': 450,
    'Whole Price': 4000,
    'Whole Deposit': 850,
    ...over,
  };
}

/** The same ranch WITHOUT the opt-in: phone-only, invisible. */
function phoneOnlyBrokerRanch(over: Record<string, any> = {}): Record<string, any> {
  const r = selfServeBrokerRanch(over);
  delete (r as any)['Broker Self Serve'];
  return r;
}

// ---------------------------------------------------------------------------
// isBrokerRoutable — the predicate itself
// ---------------------------------------------------------------------------

test('isBrokerRoutable: self-serve + publicly resolvable + priced ⇒ TRUE', () => {
  assert.equal(isBrokerRoutable(selfServeBrokerRanch()), true);
});

test('isBrokerRoutable: broker WITHOUT the self-serve opt-in ⇒ false (phone-only stays invisible)', () => {
  const r = phoneOnlyBrokerRanch();
  assert.equal(isBrokerRancher(r), true, 'fixture must still be broker-flagged');
  assert.equal(isBrokerSelfServe(r), false);
  assert.equal(isBrokerRoutable(r), false);
});

test('isBrokerRoutable: Verification Status "Removed" ⇒ false (closed account, page 404s)', () => {
  assert.equal(
    isBrokerRoutable(selfServeBrokerRanch({ 'Verification Status': 'Removed' })),
    false,
  );
  // The Airtable {name}-object read shape must be handled too.
  assert.equal(
    isBrokerRoutable(selfServeBrokerRanch({ 'Verification Status': { name: 'Removed' } })),
    false,
  );
  // Any OTHER verification value is fine — this is not a "must be Verified" gate.
  assert.equal(
    isBrokerRoutable(selfServeBrokerRanch({ 'Verification Status': 'Verified' })),
    true,
  );
});

test('isBrokerRoutable: Public Map Hidden ⇒ false (never route to a page that will not resolve)', () => {
  // Mirrors lib/airtable rancherOrProspectBySlugFormula, which gates on this
  // unconditionally — a hidden ranch's slug does not resolve, so a routed
  // buyer would land on a 404 with money in hand.
  assert.equal(isBrokerRoutable(selfServeBrokerRanch({ 'Public Map Hidden': true })), false);
  assert.equal(isBrokerRoutable(selfServeBrokerRanch({ 'Public Map Hidden': false })), true);
});

test('isBrokerRoutable: no Slug ⇒ false (on this rail the reserve surface IS the slug page)', () => {
  assert.equal(isBrokerRoutable(selfServeBrokerRanch({ Slug: '' })), false);
  assert.equal(isBrokerRoutable(selfServeBrokerRanch({ Slug: '   ' })), false);
  const noSlug = selfServeBrokerRanch();
  delete (noSlug as any).Slug;
  assert.equal(isBrokerRoutable(noSlug), false);
});

test('isBrokerRoutable: no cut the checkout would take money for ⇒ false', () => {
  const unpriced = selfServeBrokerRanch({
    'Quarter Price': null, 'Quarter Deposit': null,
    'Half Price': null, 'Half Deposit': null,
    'Whole Price': null, 'Whole Deposit': null,
  });
  assert.equal(isBrokerRoutable(unpriced), false);

  // Priced but with NO explicit deposit — the broker rail never derives one
  // (the deposit IS the commission), so the checkout would refuse.
  const noDeposits = selfServeBrokerRanch({
    'Quarter Deposit': null, 'Half Deposit': null, 'Whole Deposit': null,
  });
  assert.equal(isBrokerRoutable(noDeposits), false);

  // ONE sellable cut is enough.
  const oneCut = selfServeBrokerRanch({
    'Quarter Price': null, 'Quarter Deposit': null,
    'Whole Price': null, 'Whole Deposit': null,
  });
  assert.equal(isBrokerRoutable(oneCut), true);

  // Deposit >= price is a config error, not a 100%-upfront sale.
  assert.equal(
    isBrokerRoutable(selfServeBrokerRanch({
      'Quarter Deposit': 1100, 'Half Deposit': 2100, 'Whole Deposit': 4000,
    })),
    false,
  );
});

test('isBrokerRoutable: a Connect footprint ⇒ false (that ranch belongs on the other rail)', () => {
  // Double-billing guard: assertBrokerEligible GATE 2. Pinned here because
  // routing a dual-flagged ranch is how a buyer would be charged twice.
  assert.equal(
    isBrokerRoutable(selfServeBrokerRanch({ 'Stripe Connect Account Id': 'acct_x1' })),
    false,
  );
  assert.equal(isBrokerRoutable(selfServeBrokerRanch({ 'Pricing Model': 'tier_v2' })), false);
});

test('isBrokerRoutable: the self-serve box on a NON-broker ranch relaxes nothing', () => {
  const notBroker = selfServeBrokerRanch();
  delete (notBroker as any)['Broker Rail'];
  assert.equal(isBrokerRoutable(notBroker), false);
});

// ---------------------------------------------------------------------------
// ELIGIBILITY — the whole point: routable WITHOUT the Connect paperwork
// ---------------------------------------------------------------------------

test('eligibility: a self-serve broker ranch is operational with NO Active Status / Agreement / Connect', () => {
  const r = selfServeBrokerRanch();
  assert.equal(r['Active Status'], undefined, 'fixture must have no Active Status');
  assert.equal(r['Agreement Signed'], undefined, 'fixture must have no signed agreement');
  assert.equal(r['Stripe Connect Status'], undefined, 'fixture must have no Connect');
  assert.equal(isRancherOperationalForBuyers(r as any), true);
});

test('eligibility: a phone-only broker ranch stays NON-operational', () => {
  assert.equal(isRancherOperationalForBuyers(phoneOnlyBrokerRanch() as any), false);
});

test('eligibility: a Connect rancher is byte-unchanged by the broker exception', () => {
  const connect = {
    id: 'recCONNECT000001',
    'Ranch Name': 'Stone Fork Beef',
    State: 'MT',
    Slug: 'stone-fork-beef',
    'Active Status': 'Active',
    'Agreement Signed': true,
    'Onboarding Status': 'Live',
    'Subscription Status': 'active',
    'Pricing Model': 'tier_v2',
    'Stripe Connect Status': 'active',
  };
  assert.equal(isRancherOperationalForBuyers(connect as any), true);

  // Every Connect gate still bites, exactly as before.
  for (const [field, value] of [
    ['Active Status', 'Paused'],
    ['Agreement Signed', false],
    ['Onboarding Status', 'In Progress'],
    ['Subscription Status', 'past_due'],
    ['Stripe Connect Status', 'onboarding'],
    ['Verification Status', 'Removed'],
  ] as Array<[string, any]>) {
    assert.equal(
      isRancherOperationalForBuyers({ ...connect, [field]: value } as any),
      false,
      `Connect gate "${field}" stopped biting`,
    );
  }
});

// ---------------------------------------------------------------------------
// SERVED STATES — coverage, and the AZ bug this whole change exists for
// ---------------------------------------------------------------------------

test('served states: a self-serve broker ranch yields its primary State', () => {
  assert.deepEqual(getOperationalServedStates(selfServeBrokerRanch() as any), ['AZ']);
});

test('served states: a phone-only broker ranch yields []', () => {
  assert.deepEqual(getOperationalServedStates(phoneOnlyBrokerRanch() as any), []);
});

test('served states: NO new Airtable field — multi-state still needs Admin Approved Multi-State', () => {
  // Routing States / States Served stay ignored without the admin tick, for
  // broker ranches exactly as for everyone else.
  const spread = selfServeBrokerRanch({ 'Routing States': 'NM, UT, NV' });
  assert.deepEqual(getOperationalServedStates(spread as any), ['AZ']);
  assert.deepEqual(
    getOperationalServedStates({ ...spread, 'Admin Approved Multi-State': true } as any).sort(),
    ['AZ', 'NM', 'NV', 'UT'],
  );
});

test('served states: the AZ bug — a self-serve broker ranch makes its state SERVED', () => {
  // Before: AZ's only ranch was represented ⇒ state unserved ⇒ the buyer fell
  // to the nationwide fallback and was routed out of state.
  const az = [selfServeBrokerRanch()];
  assert.equal(hasOperationalRancherForState(az as any, 'AZ'), true);
  assert.equal(hasOperationalRancherForState([phoneOnlyBrokerRanch()] as any, 'AZ'), false);
  // And it does NOT accidentally serve anywhere else.
  assert.equal(hasOperationalRancherForState(az as any, 'MT'), false);
});
