// PRE-FLIP GUARD (finding 2, 2026-07-01): the multi-state per-state sub-cap
// (matching/suggest equal-floor split) used floor(maxReferrals / numStates)
// clamped at 0 — so a low-capacity rancher approved for many states silently
// got 0 slots per state and rejected EVERY cold lead in states they were
// explicitly approved to serve. An approved state must always get ≥ 1 slot;
// the global capacity cap (checked before the sub-cap) stays authoritative,
// so the floor can never over-route a rancher past their real max.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { equalStateSubCap } from './stateSubCap';

test('single-state rancher: no split — sub-cap is the full cap (legacy behavior)', () => {
  assert.equal(equalStateSubCap(5, 1), 5);
  assert.equal(equalStateSubCap(12, 0), 12);
});

test('even splits stay exact', () => {
  assert.equal(equalStateSubCap(10, 2), 5);
  assert.equal(equalStateSubCap(9, 3), 3);
});

test('uneven splits floor, leaving remainder to the global cap', () => {
  assert.equal(equalStateSubCap(10, 3), 3); // 9 allocated, global cap holds the 10th
});

test('THE FIX: low-capacity + wide enumeration floors at 1, never 0', () => {
  // max 5 across 6 states used to floor to 0 → every state zeroed.
  assert.equal(equalStateSubCap(5, 6), 1);
  assert.equal(equalStateSubCap(1, 50), 1);
  assert.equal(equalStateSubCap(2, 3), 1);
});

test('max 0 still yields the 1-slot floor — global cap (0) governs upstream', () => {
  // A rancher with Max Active Referrals = 0 is excluded by the global cap
  // check BEFORE the sub-cap is ever consulted, so the floor here is inert.
  assert.equal(equalStateSubCap(0, 4), 1);
});

test('garbage in → sane out (never NaN / negative)', () => {
  assert.equal(equalStateSubCap(NaN as any, 3), 1);
  assert.equal(equalStateSubCap(-5, 3), 1);
  assert.equal(equalStateSubCap(10, NaN as any), 10); // unknown split → no split
});
