import { test } from 'node:test';
import assert from 'node:assert/strict';
// Import from routingPriority (pure, no secrets side-effect) — NOT from tiers,
// whose secrets re-export requires ADMIN_PASSWORD at import time.
import {
  routingWeightForTier,
  retainerPriorityCompare,
  retainerPriorityCompareWithOverride,
  parseRoutingWeightOverride,
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

// ── Per-rancher operator override (Ashcraft: all TX leads regardless of tier) ─
test('parseRoutingWeightOverride: number in, garbage/empty/≤0 → null', () => {
  assert.equal(parseRoutingWeightOverride(100), 100);
  assert.equal(parseRoutingWeightOverride('100'), 100); // Airtable string shape
  assert.equal(parseRoutingWeightOverride(null), null);
  assert.equal(parseRoutingWeightOverride(undefined), null);
  assert.equal(parseRoutingWeightOverride(''), null);
  assert.equal(parseRoutingWeightOverride('abc'), null);
  assert.equal(parseRoutingWeightOverride(0), null);
  assert.equal(parseRoutingWeightOverride(-5), null);
});

test('override wins ABSOLUTELY — no starvation floor (heavy-loaded override still first)', () => {
  // Ashcraft override=100 with 41 active refs vs free rancher with 0 refs:
  // tier compare would defer (floor exceeded); override must still win.
  assert.ok(retainerPriorityCompareWithOverride(FREE, 41, 100, FREE, 0, null) < 0);
  assert.ok(retainerPriorityCompareWithOverride(FREE, 0, null, FREE, 41, 100) > 0);
  // Override even beats a Ranch-tier retainer.
  assert.ok(retainerPriorityCompareWithOverride(FREE, 41, 100, RANCH, 0, null) < 0);
});

test('no override on either side → identical to the floored tier compare', () => {
  assert.equal(
    retainerPriorityCompareWithOverride(RANCH, 5, null, FREE, 1, null),
    retainerPriorityCompare(RANCH, 5, FREE, 1),
  );
  assert.equal(
    retainerPriorityCompareWithOverride(RANCH, 1, null, FREE, 1, null),
    retainerPriorityCompare(RANCH, 1, FREE, 1),
  );
});

test('two equal overrides → fall through to load-balance (fair split)', () => {
  assert.equal(retainerPriorityCompareWithOverride(FREE, 3, 100, FREE, 9, 100), 0);
});

test('override below a tier weight can also DEMOTE (operator intent both ways)', () => {
  // override=1 on a Ranch rancher vs plain Pasture (eff 1 vs 2) → pasture first
  assert.ok(retainerPriorityCompareWithOverride(RANCH, 0, 1, PASTURE, 0, null) > 0);
});
