// lib/statsFallback.test.ts
//
// Wave B "stats-truth" sweep (2026-08-17): every hardcoded public-stats
// fallback number a buyer or backer can see must come from ONE dated module
// (lib/statsFallback) and must never overwrite a REAL low answer from
// /api/stats/public. Pins:
//   1. requireLiveStats passes real low numbers through untouched (the old
//      /founders coercion floors replaced familiesMatched<=0 with 1533 and
//      states<=0 with 5 — invented numbers over true API answers).
//   2. requireLiveStats treats a partial payload as a FAILED fetch (throw)
//      instead of silently inventing numbers.
//   3. The fallback constants are refreshed (not the frozen 17/1533/5/11 set)
//      and single-sourced: every consumer file imports lib/statsFallback and
//      assigns no numeric literal to a stale-able public-stat field.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STATS_FALLBACK, requireLiveStats } from './statsFallback';
import { FOUNDING_BRAND_PARTNER_CAP } from './tiers';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('requireLiveStats renders real low API numbers instead of replacing them', () => {
  const out = requireLiveStats(
    { familiesMatched: 3, states: 1, ranchersActive: 0 },
    ['familiesMatched', 'states', 'ranchersActive']
  );
  assert.equal(out.familiesMatched, 3);
  assert.equal(out.states, 1);
  // Zero is a real answer, not a failure — a fallback here would be a lie.
  assert.equal(out.ranchersActive, 0);
});

test('requireLiveStats treats a partial payload as a failed fetch', () => {
  assert.throws(() =>
    requireLiveStats({ familiesMatched: 5 }, ['familiesMatched', 'states'])
  );
  assert.throws(() =>
    requireLiveStats({ familiesMatched: 'lots', states: 2 }, ['familiesMatched', 'states'])
  );
  assert.throws(() => requireLiveStats(null, ['states']));
});

test('fallback constants are the refreshed set, not the frozen 2026-05 numbers', () => {
  assert.notEqual(STATS_FALLBACK.ranchersActive, 17);
  assert.notEqual(STATS_FALLBACK.familiesMatched, 1533);
  assert.notEqual(STATS_FALLBACK.states, 5);
  assert.notEqual(STATS_FALLBACK.totalClosedWon, 11);
  // Brand-partner slots = cap minus paid partners; with zero paid partners the
  // honest fallback IS the cap — never a manufactured-scarcity 5.
  assert.equal(STATS_FALLBACK.brandPartnersRemaining, FOUNDING_BRAND_PARTNER_CAP);
});

const CONSUMERS = [
  '../app/api/stats/public/route.ts',
  '../app/founders/page.tsx',
  '../app/wholesale/page.tsx',
  '../app/brand-partners/page.tsx',
];

const STALEABLE_FIELDS = [
  'ranchersActive',
  'familiesMatched',
  'totalClosedWon',
  'states',
  'rancherCount',
  'buyerCount',
  'stateCount',
  'verifiedRancherCount',
  'beefBuyerCount',
  'verifiedStateCount',
  'brandPartnersRemaining',
];

test('every stats-fallback consumer imports the shared module and hardcodes nothing', () => {
  for (const rel of CONSUMERS) {
    const src = read(rel);
    assert.match(
      src,
      /from '@\/lib\/statsFallback'/,
      `${rel} must import lib/statsFallback`
    );
    assert.doesNotMatch(src, /1,?533/, `${rel} still carries the frozen 1533 families number`);
    for (const field of STALEABLE_FIELDS) {
      assert.doesNotMatch(
        src,
        new RegExp(`${field}:\\s*\\d`),
        `${rel}: "${field}:" is assigned a numeric literal — use STATS_FALLBACK.${field.replace(/Count$/, '')} instead`
      );
    }
  }
});

test('the /founders coercion floors are gone (real low API answers render as-is)', () => {
  const src = read('../app/founders/page.tsx');
  assert.doesNotMatch(src, /familiesMatched\)\s*>\s*0\s*\?/);
  assert.doesNotMatch(src, /states\)\s*>\s*0\s*\?/);
});
