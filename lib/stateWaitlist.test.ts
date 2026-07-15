// lib/stateWaitlist.test.ts — the honest-fallback count aggregation.
// Runner: npx tsx --test lib/stateWaitlist.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWaitlistByState } from './stateWaitlist';

test('countWaitlistByState: counts per normalized code — "Texas" and "TX" are the same bucket', () => {
  const counts = countWaitlistByState([
    { State: 'TX' },
    { State: 'Texas' },
    { State: 'tx' },
    { State: 'CO' },
  ]);
  assert.equal(counts['TX'], 3);
  assert.equal(counts['CO'], 1);
});

test('countWaitlistByState: junk/blank states are dropped, never invented into a bucket', () => {
  const counts = countWaitlistByState([
    { State: '' },
    { State: 'Bogusland' },
    {},
    { State: null },
    { State: 'MO' },
  ]);
  assert.deepEqual(counts, { MO: 1 });
});

test('countWaitlistByState: empty input → empty map (a REAL zero, distinct from null-unknown)', () => {
  assert.deepEqual(countWaitlistByState([]), {});
});
