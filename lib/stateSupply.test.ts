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
