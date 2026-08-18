// BROKER RAIL guardrails — a represented rancher must be INVISIBLE to the
// platform, EXCEPT for the self-serve opt-in (2026-08-17).
//
// The fixtures here are all PHONE-ONLY represented ranches: `Broker Rail`
// checked, `Broker Self Serve` NOT checked. Those stay invisible everywhere,
// and that is what these tests pin. The demand-side exception — a self-serve
// ranch IS routable supply — is pinned in lib/brokerRoutable.test.ts, and the
// money guard that keeps such a match deposit-first is in lib/brokerMatch.test.ts.
//
// One test per exclusion surface. Each fixture is built as a rancher who would
// OTHERWISE PASS that surface's gate, so the test fails if the broker
// exclusion is ever removed — a test that only asserts "blank Active Status is
// excluded" would still pass with the exclusion deleted and prove nothing.
//
// Synthetic names only — the repo is PUBLIC.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRancherOperationalForBuyers,
  getOperationalServedStates,
  hasOperationalRancherForState,
} from './rancherEligibility';
import { countLiveShareRanchesByState } from './stateSupply';
import { segmentRanchers } from './rancherReactivationSegment';
import { BROKER_RAIL_EXCLUSION_FORMULA } from './brokerRail';

/**
 * A rancher who satisfies EVERY existing routing gate — Active, signed, Live,
 * subscription healthy, legacy pricing so no Connect is required. The ONLY
 * thing that can exclude them is the Broker Rail flag. This is the fixture that
 * makes the guardrail tests meaningful.
 */
function otherwisePerfectRancher(over: Record<string, any> = {}) {
  return {
    id: 'recBROKERGUARD01',
    'Ranch Name': 'Cedar Draw Beef',
    'Active Status': 'Active',
    'Agreement Signed': true,
    'Onboarding Status': 'Live',
    'Subscription Status': 'active',
    'Pricing Model': 'legacy',
    State: 'MT',
    'Page Live': true,
    Email: 'sam@example.com',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// ROUTING — the chokepoint (~25 call sites: matching/suggest, batch-approve,
// bulkRoute, demand-router, reserve, orders/request, reorder, consumers
// signup gate, reassign, warmup, command-center, public stats)
// ---------------------------------------------------------------------------

test('GUARDRAIL routing: the fixture WOULD route if it were not broker-rail (proves the test bites)', () => {
  assert.equal(isRancherOperationalForBuyers(otherwisePerfectRancher()), true);
});

test('GUARDRAIL routing: a PHONE-ONLY broker rancher is never operational, even with Active + signed + Live', () => {
  const r = otherwisePerfectRancher({ 'Broker Rail': true });
  assert.equal(isRancherOperationalForBuyers(r), false);
});

test('GUARDRAIL routing: a future Active-Status flip cannot expose a phone-only broker rancher', () => {
  // The scenario this exists for: someone flips Active Status on a represented
  // ranch. Blank-Active is NOT what protects them — the explicit flag is.
  // Still true after the self-serve exception: routability is decided by
  // isBrokerRoutable, which never reads Active Status in either direction.
  for (const active of ['Active', 'At Capacity', 'Paused', '']) {
    assert.equal(
      isRancherOperationalForBuyers(otherwisePerfectRancher({ 'Active Status': active, 'Broker Rail': true })),
      false,
      `broker rancher leaked with Active Status="${active}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// SUPPLY COVERAGE — getOperationalServedStates does NOT call the predicate
// above, so it needs its own exclusion (and its own test).
// ---------------------------------------------------------------------------

test('GUARDRAIL coverage: a PHONE-ONLY broker rancher serves NO states', () => {
  const plain = otherwisePerfectRancher();
  assert.deepEqual(getOperationalServedStates(plain), ['MT']);
  assert.deepEqual(getOperationalServedStates({ ...plain, 'Broker Rail': true }), []);
});

test('GUARDRAIL coverage: a PHONE-ONLY-broker state reads as UNSERVED at the signup gate', () => {
  // A buyer in MT whose only "supply" is a represented ranch must go to the
  // waitlist, not be told a rancher is available.
  const brokerOnly = [otherwisePerfectRancher({ 'Broker Rail': true })];
  assert.equal(hasOperationalRancherForState(brokerOnly, 'MT'), false);
  assert.equal(hasOperationalRancherForState([otherwisePerfectRancher()], 'MT'), true);
});

// ---------------------------------------------------------------------------
// PUBLIC SUPPLY COUNTS (/shop ↔ /half-a-cow must agree)
// ---------------------------------------------------------------------------

test('GUARDRAIL public counts: a broker rancher is not counted as live share supply', () => {
  const live = otherwisePerfectRancher();
  assert.deepEqual(countLiveShareRanchesByState([live]), { MT: 1 });
  assert.deepEqual(countLiveShareRanchesByState([{ ...live, 'Broker Rail': true }]), {});
});

// ---------------------------------------------------------------------------
// REACTIVATION — a represented rancher's blank Onboarding Status is exactly
// the Tier B "never onboarded" signal, so without the exclusion they would be
// the TOP of every win-back run.
// ---------------------------------------------------------------------------

test('GUARDRAIL reactivation: a broker rancher is never picked for a win-back touch', () => {
  const base = {
    id: 'recBROKERGUARD02',
    'Ranch Name': 'Cedar Draw Beef',
    'Operator Name': 'Sam Rivers',
    Email: 'sam@example.com',
    'Pricing Model': 'legacy',
    'Onboarding Status': '', // Tier B: the hottest cold-reactivation bucket
  };
  const now = new Date();

  // Blank Onboarding Status = Tier B, the cold "never onboarded" bucket.
  const without = segmentRanchers([base as any], now);
  assert.equal(
    without.tierBToSend.some((r: any) => r.id === 'recBROKERGUARD02'),
    true,
    'fixture must be reactivation-eligible WITHOUT the flag, or this test proves nothing',
  );

  const withFlag = segmentRanchers([{ ...base, 'Broker Rail': true } as any], now);
  const leaked = [
    ...withFlag.tierAToSend,
    ...withFlag.tierBToSend,
    ...withFlag.reminders,
  ].some((r: any) => r.id === 'recBROKERGUARD02');
  assert.equal(leaked, false, 'broker rancher leaked into a reactivation send bucket');
});

// ---------------------------------------------------------------------------
// PUBLIC / SEO SURFACES — those gate on Airtable FORMULAS, not the JS
// predicate, so the shared fragment is what protects them.
// ---------------------------------------------------------------------------

test('GUARDRAIL formula: the exclusion fragment is valid Airtable and checkbox-correct', () => {
  // `NOT({Broker Rail} = 1)` — Airtable checkboxes compare against 1, and NOT()
  // keeps unchecked rows (which read as blank/0) in the result set.
  assert.equal(BROKER_RAIL_EXCLUSION_FORMULA, 'NOT({Broker Rail} = 1)');
});


// ---------------------------------------------------------------------------
// RAIL-MATRIX (2026-08-04) — DUAL-FLAG precedence. A rancher flagged Broker
// Rail while ALSO carrying a full active Connect footprint is a data error.
// The precedence rule pinned here: the broker flag wins EVERYWHERE a buyer
// could be exposed (routing dark, coverage empty), and both CHARGE paths
// refuse ('ambiguous' — resolved by a human, never by a coin flip with money).
// ---------------------------------------------------------------------------

test('GUARDRAIL dual-flag: broker + full active Connect footprint is dark for routing AND coverage', () => {
  const dual = otherwisePerfectRancher({
    'Broker Rail': true,
    'Pricing Model': 'tier_v2',
    'Stripe Connect Status': 'active',
    'Stripe Connect Account Id': 'acct_dualflag01',
    Slug: 'cedar-draw-beef',
  });
  assert.equal(isRancherOperationalForBuyers(dual), false);
  assert.deepEqual(getOperationalServedStates(dual), []);
});

test('GUARDRAIL dual-flag: both charge rails classify the rancher as ambiguous and refuse', async () => {
  const { referralRailForRancher, assertBrokerEligible } = await import('./brokerRail');
  const dual = otherwisePerfectRancher({
    'Broker Rail': true,
    'Pricing Model': 'tier_v2',
    'Stripe Connect Status': 'active',
    'Stripe Connect Account Id': 'acct_dualflag01',
    'Half Price': 2000,
    'Half Deposit': 400,
  });
  // The shared classifier both checkout routes now gate on:
  assert.equal(referralRailForRancher(dual), 'ambiguous');
  // And the broker rail's own money gate refuses the Connect footprint:
  const gate = assertBrokerEligible(dual, 'half');
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.equal(gate.code, 'connect_rancher');
});
