// lib/stateSupply.test.ts — the /shop ↔ /half-a-cow supply-claim agreement.
// Runner: npm test  (whole suite; never a bare npx tsx)
//
// SCOPE OF THIS FILE: the VISIBILITY layer — who is published as supply for a
// state. The second layer, SELLABILITY (can a buyer who arrives actually
// complete a purchase — lib/rancherEligibility.isRancherSellableForBuyers), is
// pinned in lib/sellableSupply.test.ts. Both must hold, so every fixture here
// is built on a SELLABLE base and then broken in exactly the one visibility
// way each test is about. A bare `{ State, Page Live }` row is no longer supply
// on its own, and that is the point: page-live is publication, not a price tag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countLiveShareRanchesByState } from './stateSupply';

/** A sellable ONBOARDED ranch (legacy rail — no Connect/price floor to pass). */
const ranch = (over: Record<string, unknown> = {}) => ({
  'Page Live': true,
  'Active Status': 'Active',
  'Onboarding Status': 'Live',
  'Agreement Signed': true,
  'Pricing Model': 'legacy',
  ...over,
});

/** A sellable SELF-SERVE represented ranch (the #630 carve-out). */
const broker = (over: Record<string, unknown> = {}) => ({
  'Broker Rail': true,
  'Broker Self Serve': true,
  'Slug': 'gila-river-cattle',
  'Half Price': 2025,
  'Half Deposit': 200,
  ...over,
});

test('countLiveShareRanchesByState: applies the /half-a-cow visibility filter exactly', () => {
  const counts = countLiveShareRanchesByState([
    // Counts — live, visible, verified state
    ranch({ State: 'CO' }),
    ranch({ State: 'Colorado', 'Verification Status': 'Verified' }),
    // Dropped — page not live
    ranch({ State: 'CO', 'Page Live': false }),
    ranch({ State: 'CO', 'Page Live': undefined }),
    // Dropped — hidden from the public map
    ranch({ State: 'CO', 'Public Map Hidden': true }),
    // Dropped — removed
    ranch({ State: 'CO', 'Verification Status': 'Removed' }),
  ]);
  assert.deepEqual(counts, { CO: 2 });
});

test('countLiveShareRanchesByState: normalizes full names and codes into one bucket', () => {
  const counts = countLiveShareRanchesByState([
    ranch({ State: 'TX' }),
    ranch({ State: 'Texas' }),
    ranch({ State: 'tx' }),
    ranch({ State: 'MO' }),
  ]);
  assert.equal(counts['TX'], 3);
  assert.equal(counts['MO'], 1);
});

test('countLiveShareRanchesByState: junk/blank states dropped; empty input → empty map', () => {
  assert.deepEqual(
    countLiveShareRanchesByState([
      ranch({ State: '' }),
      ranch({ State: 'Bogusland' }),
      ranch(),
    ]),
    {},
  );
  assert.deepEqual(countLiveShareRanchesByState([]), {});
});

// ── WAVE A (2026-08-17): the broker self-serve carve-out ────────────────────
// The JS mirror of the shared Airtable discovery formula
// (lib/airtable stateDiscoveryRanchersFormula, pinned in
// lib/brokerDiscoverySurfaces.test.ts). Both directions, per the invariant:
// self-serve broker ranch COUNTED, token-only broker ranch INVISIBLE,
// Connect ranchers byte-unchanged.

test('countLiveShareRanchesByState: a SELF-SERVE broker ranch counts — Page Live unset', () => {
  // The launch shape: Gila River has {Page Live} unset (represented ranchers
  // never ran the wizard that sets it) — the opt-in IS page-live.
  assert.deepEqual(countLiveShareRanchesByState([broker({ State: 'AZ' })]), { AZ: 1 });
});

test('countLiveShareRanchesByState: a TOKEN-ONLY broker ranch stays invisible (the invariant)', () => {
  assert.deepEqual(
    countLiveShareRanchesByState([
      broker({ State: 'AZ', 'Broker Self Serve': false }),
      // Even a stray Page Live tick cannot publish a token-only ranch — the
      // broker branch keys on the self-serve box, never on Page Live.
      broker({ State: 'AZ', 'Broker Self Serve': false, 'Page Live': true }),
    ]),
    {},
  );
});

test('countLiveShareRanchesByState: hidden/removed gate self-serve ranches unconditionally', () => {
  assert.deepEqual(
    countLiveShareRanchesByState([
      broker({ State: 'AZ', 'Public Map Hidden': true }),
      broker({ State: 'AZ', 'Verification Status': 'Removed' }),
    ]),
    {},
  );
});

test('countLiveShareRanchesByState: a stray self-serve tick on a NON-broker ranch relaxes nothing', () => {
  // Not broker → the normal Page Live rule applies unchanged; the box alone
  // must never publish an unpublished ranch (fail closed, mirrors the
  // formula's AND({Broker Rail} = 1, {Broker Self Serve} = 1)).
  assert.deepEqual(
    countLiveShareRanchesByState([ranch({ State: 'CO', 'Page Live': false, 'Broker Self Serve': true })]),
    {},
  );
  assert.deepEqual(
    countLiveShareRanchesByState([ranch({ State: 'CO', 'Broker Self Serve': true })]),
    { CO: 1 },
  );
});

test('countLiveShareRanchesByState: mixed AZ pool — broker supply and Connect supply add up', () => {
  assert.deepEqual(
    countLiveShareRanchesByState([
      broker({ State: 'AZ' }),                              // self-serve — counts
      broker({ State: 'AZ', 'Broker Self Serve': false }),  // token-only — invisible
      ranch({ State: 'Arizona' }),                          // onboarded — counts
      ranch({ State: 'MT' }),
    ]),
    { AZ: 2, MT: 1 },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// PARKED SUPPLY (2026-08-18 audit, P1-2) — the JS mirror gets the same gate.
//
// This function is the JS half of stateDiscoveryRanchersFormula (it decides
// what /shop's empty-market fallback tells a buyer about their state). When
// the formula learned to drop Paused/Non-Compliant ranches, this mirror had
// to learn it in the same commit or /shop would go back to contradicting
// /half-a-cow — the exact class of bug lib/stateSupply exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────

test('countLiveShareRanchesByState: a PAUSED ranch is not live supply (matches the map gate)', () => {
  assert.deepEqual(
    countLiveShareRanchesByState([
      ranch({ State: 'CO', 'Active Status': 'Paused' }),
      ranch({ State: 'CO', 'Active Status': 'Paused' }),
    ]),
    {},
    'both live Colorado rows were Paused — /half-a-cow/colorado claimed "2 ranches are live"',
  );
});

test('countLiveShareRanchesByState: a NON-COMPLIANT ranch is not live supply', () => {
  assert.deepEqual(
    countLiveShareRanchesByState([ranch({ State: 'TX', 'Active Status': 'Non-Compliant' })]),
    {},
  );
});

test('countLiveShareRanchesByState: blank Active Status is not parked — the broker rail lives there', () => {
  // The parked gate is an exclusion of two NAMED statuses, never a requirement,
  // and blank is the represented-rail signup state. (An ONBOARDED ranch with a
  // blank Active Status is dropped by the sellability layer instead — the
  // matcher requires Active there, so publishing it would strand its buyers.)
  assert.deepEqual(
    countLiveShareRanchesByState([broker({ State: 'OK' }), ranch({ State: 'OK' })]),
    { OK: 2 },
  );
});

test('countLiveShareRanchesByState: a PAUSED broker self-serve ranch is still dropped', () => {
  // The #630 carve-out makes represented supply VISIBLE; it does not make it
  // immune to being parked. Blank stays visible (previous test); an explicit
  // Paused on a represented row is still Ben saying "not right now".
  assert.deepEqual(
    countLiveShareRanchesByState([broker({ State: 'AZ', 'Active Status': 'Paused' })]),
    {},
  );
  assert.deepEqual(
    countLiveShareRanchesByState([broker({ State: 'AZ' })]),
    { AZ: 1 },
    'the live AZ ranch (blank Active Status) must survive the parked gate',
  );
});
