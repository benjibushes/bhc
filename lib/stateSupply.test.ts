// lib/stateSupply.test.ts — the /shop ↔ /half-a-cow supply-claim agreement.
// Runner: npx tsx --test lib/stateSupply.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countLiveShareRanchesByState } from './stateSupply';

test('countLiveShareRanchesByState: applies the /half-a-cow visibility filter exactly', () => {
  const counts = countLiveShareRanchesByState([
    // Counts — live, visible, verified state
    { State: 'CO', 'Page Live': true },
    { State: 'Colorado', 'Page Live': true, 'Verification Status': 'Verified' },
    // Dropped — page not live
    { State: 'CO', 'Page Live': false },
    { State: 'CO' },
    // Dropped — hidden from the public map
    { State: 'CO', 'Page Live': true, 'Public Map Hidden': true },
    // Dropped — removed
    { State: 'CO', 'Page Live': true, 'Verification Status': 'Removed' },
  ]);
  assert.deepEqual(counts, { CO: 2 });
});

test('countLiveShareRanchesByState: normalizes full names and codes into one bucket', () => {
  const counts = countLiveShareRanchesByState([
    { State: 'TX', 'Page Live': true },
    { State: 'Texas', 'Page Live': true },
    { State: 'tx', 'Page Live': true },
    { State: 'MO', 'Page Live': true },
  ]);
  assert.equal(counts['TX'], 3);
  assert.equal(counts['MO'], 1);
});

test('countLiveShareRanchesByState: junk/blank states dropped; empty input → empty map', () => {
  assert.deepEqual(
    countLiveShareRanchesByState([
      { State: '', 'Page Live': true },
      { State: 'Bogusland', 'Page Live': true },
      { 'Page Live': true },
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
  assert.deepEqual(
    countLiveShareRanchesByState([{ State: 'AZ', 'Broker Rail': true, 'Broker Self Serve': true }]),
    { AZ: 1 },
  );
});

test('countLiveShareRanchesByState: a TOKEN-ONLY broker ranch stays invisible (the invariant)', () => {
  assert.deepEqual(
    countLiveShareRanchesByState([
      { State: 'AZ', 'Broker Rail': true },
      // Even a stray Page Live tick cannot publish a token-only ranch — the
      // broker branch keys on the self-serve box, never on Page Live.
      { State: 'AZ', 'Broker Rail': true, 'Page Live': true },
    ]),
    {},
  );
});

test('countLiveShareRanchesByState: hidden/removed gate self-serve ranches unconditionally', () => {
  assert.deepEqual(
    countLiveShareRanchesByState([
      { State: 'AZ', 'Broker Rail': true, 'Broker Self Serve': true, 'Public Map Hidden': true },
      { State: 'AZ', 'Broker Rail': true, 'Broker Self Serve': true, 'Verification Status': 'Removed' },
    ]),
    {},
  );
});

test('countLiveShareRanchesByState: a stray self-serve tick on a NON-broker ranch relaxes nothing', () => {
  // Not broker → the normal Page Live rule applies unchanged; the box alone
  // must never publish an unpublished ranch (fail closed, mirrors the
  // formula's AND({Broker Rail} = 1, {Broker Self Serve} = 1)).
  assert.deepEqual(countLiveShareRanchesByState([{ State: 'CO', 'Broker Self Serve': true }]), {});
  assert.deepEqual(
    countLiveShareRanchesByState([{ State: 'CO', 'Broker Self Serve': true, 'Page Live': true }]),
    { CO: 1 },
  );
});

test('countLiveShareRanchesByState: mixed AZ pool — broker supply and Connect supply add up', () => {
  assert.deepEqual(
    countLiveShareRanchesByState([
      { State: 'AZ', 'Broker Rail': true, 'Broker Self Serve': true }, // self-serve — counts
      { State: 'AZ', 'Broker Rail': true },                            // token-only — invisible
      { State: 'Arizona', 'Page Live': true },                         // onboarded — counts
      { State: 'MT', 'Page Live': true },
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
      { State: 'CO', 'Page Live': true, 'Active Status': 'Paused' },
      { State: 'CO', 'Page Live': true, 'Active Status': 'Paused' },
    ]),
    {},
    'both live Colorado rows were Paused — /half-a-cow/colorado claimed "2 ranches are live"',
  );
});

test('countLiveShareRanchesByState: a NON-COMPLIANT ranch is not live supply', () => {
  assert.deepEqual(
    countLiveShareRanchesByState([{ State: 'TX', 'Page Live': true, 'Active Status': 'Non-Compliant' }]),
    {},
  );
});

test('countLiveShareRanchesByState: Active and blank Active Status both still count', () => {
  // Blank is the broker-rail signup state and passes the map's two != checks
  // — the gate is an exclusion of two named statuses, never a requirement.
  assert.deepEqual(
    countLiveShareRanchesByState([
      { State: 'OK', 'Page Live': true, 'Active Status': 'Active' },
      { State: 'OK', 'Page Live': true },
    ]),
    { OK: 2 },
  );
});

test('countLiveShareRanchesByState: a PAUSED broker self-serve ranch is still dropped', () => {
  // The #630 carve-out makes represented supply VISIBLE; it does not make it
  // immune to being parked. Blank stays visible (previous test); an explicit
  // Paused on a represented row is still Ben saying "not right now".
  assert.deepEqual(
    countLiveShareRanchesByState([
      { State: 'AZ', 'Broker Rail': true, 'Broker Self Serve': true, 'Active Status': 'Paused' },
    ]),
    {},
  );
  assert.deepEqual(
    countLiveShareRanchesByState([{ State: 'AZ', 'Broker Rail': true, 'Broker Self Serve': true }]),
    { AZ: 1 },
    'the live AZ ranch (blank Active Status) must survive the parked gate',
  );
});
