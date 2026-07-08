// lib/stateAdjacency.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/stateAdjacency.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE_NEIGHBORS, hopDistance, adjacencyViolations } from './stateAdjacency';

test('adjacency map is symmetric (every border listed both ways)', () => {
  for (const [state, neighbors] of Object.entries(STATE_NEIGHBORS)) {
    for (const n of neighbors) {
      assert.ok(STATE_NEIGHBORS[n], `${n} (neighbor of ${state}) missing from map`);
      assert.ok(STATE_NEIGHBORS[n].includes(state), `${state}→${n} listed but not ${n}→${state}`);
    }
  }
});

test('known distances: the live rancher configs', () => {
  assert.equal(hopDistance('NE', 'CO'), 1); // Champion Valley
  assert.equal(hopDistance('NE', 'KS'), 1);
  assert.equal(hopDistance('WV', 'VA'), 1); // Renick
  assert.equal(hopDistance('MT', 'ID'), 1); // Foodstead
  assert.equal(hopDistance('MT', 'WA'), 2); // Foodstead's long leg — flagged at maxHops 1, allowed at 2
});

test('same state = 0, classic borders = 1, cross-country = far', () => {
  assert.equal(hopDistance('TX', 'TX'), 0);
  assert.equal(hopDistance('TX', 'OK'), 1);
  assert.equal(hopDistance('CA', 'NV'), 1);
  assert.equal(hopDistance('ME', 'NH'), 1);
  assert.ok(hopDistance('CA', 'NY') >= 5 || hopDistance('CA', 'NY') === Infinity);
});

test('islands and junk never match anything', () => {
  assert.equal(hopDistance('AK', 'WA'), Infinity);
  assert.equal(hopDistance('HI', 'CA'), Infinity);
  assert.equal(hopDistance('XX', 'CA'), Infinity);
  assert.equal(hopDistance('', 'CA'), Infinity);
});

test('adjacencyViolations: flags far states, skips home + near ones', () => {
  const v = adjacencyViolations('MT', ['MT', 'ID', 'WA', 'TX'], 1);
  assert.deepEqual(v.map((x) => x.state), ['WA', 'TX']);
  const v2 = adjacencyViolations('MT', ['ID', 'WA'], 2);
  assert.deepEqual(v2, []); // WA is 2 hops — fine at the default threshold
});
