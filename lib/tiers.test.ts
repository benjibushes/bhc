import { test } from 'node:test';
import assert from 'node:assert/strict';
// Import from routingPriority (pure, no secrets side-effect) — NOT from tiers,
// whose secrets re-export requires ADMIN_PASSWORD at import time.
import {
  routingWeightForTier,
  retainerPriorityCompare,
  RETAINER_FLOOR_SLACK,
} from './routingPriority';

// ── routing weights: paid retainers get graduated priority, free/legacy baseline ─
test('routingWeightForTier: paid retainers graduated, free/legacy baseline', () => {
  assert.equal(routingWeightForTier('operator'), 3);
  assert.equal(routingWeightForTier('ranch'), 3);
  assert.equal(routingWeightForTier('pasture'), 2);       // $150 retainer — priority over free
  assert.equal(routingWeightForTier('legacy_connect'), 1); // 10%, not a retainer
  assert.equal(routingWeightForTier(null), 1);             // no tier / free
});

// ── the acceptance matrix for retainer priority ──────────────────────────────
const RANCH = routingWeightForTier('ranch');       // 3
const PASTURE = routingWeightForTier('pasture');   // 2
const FREE = routingWeightForTier(null);           // 1

test('pasture ($150 retainer) beats a free rancher but yields to ranch', () => {
  assert.ok(retainerPriorityCompare(PASTURE, 1, FREE, 1) < 0);   // pasture > free
  assert.ok(retainerPriorityCompare(PASTURE, 1, RANCH, 1) > 0);  // ranch > pasture
  // pasture still starvation-protected vs free
  assert.equal(retainerPriorityCompare(PASTURE, 5, FREE, 1), 0);
});

test('(a) retainer + free, SAME load → retainer matched first', () => {
  assert.ok(retainerPriorityCompare(RANCH, 1, FREE, 1) < 0);   // a=retainer wins
  assert.ok(retainerPriorityCompare(FREE, 1, RANCH, 1) > 0);   // order-independent
});

test('(c) retainer meaningfully MORE loaded → free wins (no starvation)', () => {
  // retainer 5 refs vs free 1 ref, slack 2 → 5 > 1+2 → defer to load-balance (0)
  assert.equal(retainerPriorityCompare(RANCH, 5, FREE, 1), 0);
  assert.equal(retainerPriorityCompare(FREE, 1, RANCH, 5), 0);
});

test('retainer within the floor slack keeps priority; one past it defers', () => {
  assert.ok(retainerPriorityCompare(RANCH, 3, FREE, 1) < 0);              // 3 <= 1+2
  assert.ok(retainerPriorityCompare(RANCH, 1 + RETAINER_FLOOR_SLACK, FREE, 1) < 0); // boundary
  assert.equal(retainerPriorityCompare(RANCH, 2 + RETAINER_FLOOR_SLACK, FREE, 1), 0); // past
});

test('(e) two equal-weight retainers → tie (0), load-balance splits them', () => {
  assert.equal(retainerPriorityCompare(RANCH, 0, RANCH, 4), 0);
  assert.equal(retainerPriorityCompare(FREE, 2, FREE, 9), 0);
});

test('both empty: retainer beats free regardless of absolute load', () => {
  assert.ok(retainerPriorityCompare(RANCH, 0, FREE, 0) < 0);
});
