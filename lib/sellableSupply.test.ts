// lib/sellableSupply.test.ts — "live supply" must mean A BUYER CAN BUY.
//
// THE DEFECT (2026-08-19). Three surfaces answered "is there supply in this
// state?" with three different, all-too-generous rules:
//
//   • lib/stateSupply (the /half-a-cow/[state] + /access/[state] + /shop
//     count) gated on {Page Live} alone. California's only page-live ranch is
//     tier_v2 with Stripe Connect stuck in 'onboarding' and NO cut priced at
//     all, so it can never take a deposit — yet the page told every visitor
//     "1 ranch is live in California right now".
//   • /api/funnel/stats gated on isRancherOperationalForBuyers +
//     getOperationalServedStates with NO request-only belt, so the one
//     request-only ranch (48 Routing States) made the funnel promise "you
//     match 1 ranch near you" in 32 states with zero generic supply.
//   • the MATCHER applied a cut-price floor neither of the above knew about.
//
// Every ad dollar into one of those states bought a completed quiz that
// dead-ends on a waitlist. These pins hold all three to ONE predicate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRancherOperationalForBuyers,
  isRancherSellableForBuyers,
  hasOperationalRancherForState,
  passesCutPriceFloor,
} from './rancherEligibility';
import { countLiveShareRanchesByState } from './stateSupply';
import { getServedStates, sellableRancherCountsByState } from './routingSegment';

/** A fully-sellable Connect-rail ranch: operational AND priced. */
function connectRanch(over: Record<string, unknown> = {}) {
  return {
    id: 'recCONNECT',
    'State': 'MT',
    'Page Live': true,
    'Active Status': 'Active',
    'Onboarding Status': 'Live',
    'Agreement Signed': true,
    'Subscription Status': 'active',
    'Pricing Model': 'tier_v2',
    'Stripe Connect Status': 'active',
    'Quarter Price': 1590,
    'Half Price': 3175,
    'Whole Price': 6300,
    ...over,
  };
}

/** A self-serve represented ranch — the PR #630 carve-out that must survive. */
function brokerRanch(over: Record<string, unknown> = {}) {
  return {
    id: 'recBROKER',
    'State': 'AZ',
    'Broker Rail': true,
    'Broker Self Serve': true,
    'Slug': 'gila-river-cattle',
    'Quarter Price': 1050,
    'Quarter Deposit': 100,
    'Half Price': 2025,
    'Half Deposit': 200,
    'Whole Price': 4050,
    'Whole Deposit': 400,
    ...over,
  };
}

// ── The predicate itself ───────────────────────────────────────────────────

test('baseline: a priced, Connect-active ranch is sellable', () => {
  assert.equal(isRancherSellableForBuyers(connectRanch()), true);
});

test('CALIFORNIA: tier_v2 + Connect "onboarding" is NOT sellable supply', () => {
  assert.equal(
    isRancherSellableForBuyers(connectRanch({ 'Stripe Connect Status': 'onboarding' })),
    false,
  );
});

test('PRICE-LESS: tier_v2 with no cut priced is NOT sellable, even Connect-active', () => {
  assert.equal(
    isRancherSellableForBuyers(
      connectRanch({ 'Quarter Price': null, 'Half Price': null, 'Whole Price': null }),
    ),
    false,
  );
});

test('PER-LB MIS-ENTRY: a "$7.40 whole cow" does not clear the floor', () => {
  assert.equal(
    isRancherSellableForBuyers(
      connectRanch({ 'Quarter Price': 7.4, 'Half Price': 7.4, 'Whole Price': 7.4 }),
    ),
    false,
  );
});

test('ONE priced cut is enough — the supply question is not cut-specific', () => {
  assert.equal(
    isRancherSellableForBuyers(
      connectRanch({ 'Quarter Price': null, 'Half Price': 2600, 'Whole Price': null }),
    ),
    true,
  );
});

test('LEGACY rail keeps its exemption — off-platform checkout, no floor', () => {
  // Mirrors the matcher: the cut floor is tier_v2-ONLY because a legacy
  // rancher sells through their own links / on the phone. Removing this would
  // strand the rail that earns most of BHC's money.
  assert.equal(
    isRancherSellableForBuyers(
      connectRanch({
        'Pricing Model': 'legacy',
        'Stripe Connect Status': '',
        'Quarter Price': null,
        'Half Price': null,
        'Whole Price': null,
      }),
    ),
    true,
  );
});

test('BROKER CARVE-OUT (#630): a self-serve represented ranch stays sellable', () => {
  assert.equal(isRancherSellableForBuyers(brokerRanch()), true);
});

test('BROKER: an unpriced / deposit-less represented ranch is not sellable', () => {
  assert.equal(
    isRancherSellableForBuyers(brokerRanch({ 'Half Deposit': null, 'Quarter Deposit': null, 'Whole Deposit': null })),
    false,
  );
});

test('BROKER: token-only (no self-serve opt-in) stays invisible', () => {
  assert.equal(isRancherSellableForBuyers(brokerRanch({ 'Broker Self Serve': false })), false);
});

// ── The floor is ONE definition, shared with the matcher ───────────────────

test('passesCutPriceFloor: cut-specific when the buyer tier is known', () => {
  const r = connectRanch({ 'Quarter Price': null, 'Half Price': 2600, 'Whole Price': null });
  assert.equal(passesCutPriceFloor(r, 'Half'), true);
  assert.equal(passesCutPriceFloor(r, 'Quarter'), false);
  assert.equal(passesCutPriceFloor(r, 'Whole'), false);
  // Ambiguous tier falls back to any-cut so an undecided buyer is not
  // over-excluded — the matcher's documented behavior.
  assert.equal(passesCutPriceFloor(r, null), true);
});

test('passesCutPriceFloor: legacy + broker rails always pass (no Connect floor)', () => {
  assert.equal(passesCutPriceFloor({ 'Pricing Model': 'legacy' }, 'Whole'), true);
  assert.equal(passesCutPriceFloor({ 'Broker Rail': true }, 'Whole'), true);
});

// ── Consumer 1: lib/stateSupply (state pages + /shop empty-market) ─────────

test('stateSupply: a page-live but unsellable ranch no longer counts', () => {
  const dead = connectRanch({
    id: 'recCA',
    'State': 'CA',
    'Stripe Connect Status': 'onboarding',
    'Quarter Price': null,
    'Half Price': null,
    'Whole Price': null,
  });
  assert.deepEqual(countLiveShareRanchesByState([dead]), {});
});

test('stateSupply: sellable ranches still count, broker included', () => {
  assert.deepEqual(
    countLiveShareRanchesByState([connectRanch(), brokerRanch()]),
    { MT: 1, AZ: 1 },
  );
});

test('stateSupply: the parked/hidden/removed gates still bite a sellable ranch', () => {
  assert.deepEqual(countLiveShareRanchesByState([connectRanch({ 'Active Status': 'Paused' })]), {});
  assert.deepEqual(countLiveShareRanchesByState([connectRanch({ 'Public Map Hidden': true })]), {});
  assert.deepEqual(
    countLiveShareRanchesByState([connectRanch({ 'Verification Status': 'Removed' })]),
    {},
  );
});

// ── Consumer 2: routingSegment served states / per-state counts ────────────

test('getServedStates: a Connect-incomplete ranch contributes no state', () => {
  const dead = connectRanch({ 'State': 'ME', 'Stripe Connect Status': 'onboarding' });
  assert.deepEqual(Array.from(getServedStates([dead])), []);
});

test('getServedStates: OPERATIONAL BUT UNPRICED contributes no state either', () => {
  // The mutation this pin exists to kill: reverting the helper to
  // isRancherOperationalForBuyers alone. This ranch passes every operational
  // gate — Active, Live, signed, Connect active — and still cannot be paid,
  // because no cut clears the floor the deposit endpoint enforces. Coverage
  // built on the weaker gate promises a buyer a ranch the matcher will reject.
  const unpriced = connectRanch({
    'State': 'NV',
    'Quarter Price': null,
    'Half Price': null,
    'Whole Price': null,
  });
  assert.equal(isRancherOperationalForBuyers(unpriced), true, 'fixture must be operational');
  assert.deepEqual(Array.from(getServedStates([unpriced])), []);
  assert.deepEqual(sellableRancherCountsByState([unpriced]), {});
  assert.equal(hasOperationalRancherForState([unpriced], 'NV'), false);
  assert.deepEqual(countLiveShareRanchesByState([unpriced]), {});
});

test('sellableRancherCountsByState: counts, and agrees with getServedStates', () => {
  const rows = [
    connectRanch(),
    brokerRanch(),
    connectRanch({ id: 'recDEAD', 'State': 'CA', 'Stripe Connect Status': 'onboarding' }),
  ];
  const counts = sellableRancherCountsByState(rows);
  assert.deepEqual(counts, { MT: 1, AZ: 1 });
  assert.deepEqual(
    Object.keys(counts).sort(),
    Array.from(getServedStates(rows)).sort(),
  );
});

test('sellableRancherCountsByState: request-only supply is never generic coverage', () => {
  // Rep Provisions carries Admin Approved Multi-State + 48 Routing States; it
  // inflated /api/funnel/stats from 16 real states to 48.
  const requestOnly = connectRanch({
    id: 'recYE5zpedhPg6KIV',
    'State': 'OK',
    'Slug': 'rep-provisions',
    'Admin Approved Multi-State': true,
    'Routing States': 'OK, TX, CA, ME, NY',
  });
  assert.deepEqual(sellableRancherCountsByState([requestOnly]), {});
});

// ── Consumer 3: the signup-time READY-vs-WAITLIST gate ─────────────────────

test('hasOperationalRancherForState: agrees with getServedStates, state by state', () => {
  // The signup gate cannot import getServedStates (routingSegment imports
  // rancherEligibility), so the two rules are written twice. Pin that they
  // never drift: a state is READY iff it is a served state.
  const rows = [
    connectRanch({ 'State': 'MT' }),
    brokerRanch({ 'State': 'AZ' }),
    connectRanch({ id: 'recDEAD', 'State': 'CA', 'Stripe Connect Status': 'onboarding' }),
    connectRanch({
      id: 'recYE5zpedhPg6KIV',
      'State': 'OK',
      'Slug': 'rep-provisions',
      'Admin Approved Multi-State': true,
      'Routing States': 'OK, NY',
    }),
  ];
  const served = getServedStates(rows);
  for (const code of ['MT', 'AZ', 'CA', 'OK', 'NY', 'TX']) {
    assert.equal(
      hasOperationalRancherForState(rows, code),
      served.has(code),
      `${code}: signup gate and served-states disagree`,
    );
  }
  // And concretely, so the pin fails loudly rather than agreeing on nonsense:
  assert.equal(hasOperationalRancherForState(rows, 'MT'), true);
  assert.equal(hasOperationalRancherForState(rows, 'CA'), false, 'CA has no sellable supply');
  assert.equal(hasOperationalRancherForState(rows, 'OK'), false, 'request-only is not coverage');
});
