// lib/gear.test.ts
//
// Pure-selector tests for the affiliate-products layer (Move 1). Runner:
// JWT_SECRET=test-secret-ci npx tsx --test lib/gear.test.ts
//
// getGearCatalog is NOT tested here — it does I/O (getAllRecords). The pure
// logic (selectGear + emailSafeGear) is where every compliance + curation rule
// lives, so that's what we lock down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectGear, emailSafeGear, type GearProduct } from './gear';

// Factory: an Active, universal, any-stage product. Overrides tweak one axis.
function prod(overrides: Partial<GearProduct> & { id: string }): GearProduct {
  return {
    Name: overrides.id,
    Category: 'other',
    'Affiliate URL': `https://ex.com/${overrides.id}`,
    Network: 'direct',
    'Target Cuts': [],
    'Target Stage': 'any',
    'Sort Order': 100,
    'Freezer Mandatory': false,
    Active: true,
    ...overrides,
  };
}

// ── active-only ────────────────────────────────────────────────────────────────

test('drops inactive products (Active !== true)', () => {
  const products = [
    prod({ id: 'live' }),
    prod({ id: 'draft', Active: false }),
    prod({ id: 'absent', Active: undefined }),
  ];
  const got = selectGear(products, { cut: 'half', stage: 'waiting' });
  assert.deepEqual(got.map((p) => p.id), ['live']);
});

// ── stage filter ───────────────────────────────────────────────────────────────

test('stage filter: matches stage OR any; a blank stage counts as any', () => {
  const products = [
    prod({ id: 'wait', 'Target Stage': 'waiting' }),
    prod({ id: 'deliv', 'Target Stage': 'delivered' }),
    prod({ id: 'any', 'Target Stage': 'any' }),
    prod({ id: 'blank', 'Target Stage': '' }),
  ];
  const got = selectGear(products, { cut: 'half', stage: 'waiting' });
  assert.deepEqual(got.map((p) => p.id).sort(), ['any', 'blank', 'wait']);
});

// ── cut filter + universal ─────────────────────────────────────────────────────

test('cut filter: Target Cuts must include the cut, unless empty (universal)', () => {
  const products = [
    prod({ id: 'universal', 'Target Cuts': [] }),
    prod({ id: 'half-only', 'Target Cuts': ['half'] }),
    prod({ id: 'whole-only', 'Target Cuts': ['whole'] }),
    prod({ id: 'q-and-h', 'Target Cuts': ['quarter', 'half'] }),
  ];
  const half = selectGear(products, { cut: 'half', stage: 'waiting' });
  assert.deepEqual(half.map((p) => p.id).sort(), ['half-only', 'q-and-h', 'universal']);
});

test('universal (empty Target Cuts) shows for every cut', () => {
  const products = [prod({ id: 'universal', 'Target Cuts': [] })];
  for (const cut of ['quarter', 'half', 'whole'] as const) {
    assert.deepEqual(
      selectGear(products, { cut, stage: 'waiting' }).map((p) => p.id),
      ['universal'],
    );
  }
});

test('cut === null shows ONLY universal products', () => {
  const products = [
    prod({ id: 'universal', 'Target Cuts': [] }),
    prod({ id: 'half-only', 'Target Cuts': ['half'] }),
  ];
  const got = selectGear(products, { cut: null, stage: 'waiting' });
  assert.deepEqual(got.map((p) => p.id), ['universal']);
});

// ── whole-cow: freezer mandatory pins first ────────────────────────────────────

test('whole-cow: Freezer Mandatory products pin to the very top', () => {
  const products = [
    prod({ id: 'rub', 'Sort Order': 1, 'Freezer Mandatory': false }),
    prod({ id: 'freezer', 'Sort Order': 50, 'Freezer Mandatory': true }),
    prod({ id: 'knife', 'Sort Order': 2, 'Freezer Mandatory': false }),
  ];
  const got = selectGear(products, { cut: 'whole', stage: 'waiting' });
  // freezer first (despite Sort Order 50), then rest by Sort Order.
  assert.deepEqual(got.map((p) => p.id), ['freezer', 'rub', 'knife']);
});

test('non-whole cut does NOT freezer-pin — pure Sort Order', () => {
  const products = [
    prod({ id: 'rub', 'Sort Order': 1, 'Freezer Mandatory': false }),
    prod({ id: 'freezer', 'Sort Order': 50, 'Freezer Mandatory': true }),
  ];
  const got = selectGear(products, { cut: 'half', stage: 'waiting' });
  assert.deepEqual(got.map((p) => p.id), ['rub', 'freezer']);
});

// ── sort: Sort Order, then direct before amazon ────────────────────────────────

test('sort: Sort Order ascending', () => {
  const products = [
    prod({ id: 'c', 'Sort Order': 3 }),
    prod({ id: 'a', 'Sort Order': 1 }),
    prod({ id: 'b', 'Sort Order': 2 }),
  ];
  const got = selectGear(products, { cut: 'half', stage: 'waiting' });
  assert.deepEqual(got.map((p) => p.id), ['a', 'b', 'c']);
});

test('sort tiebreak: direct before amazon at equal Sort Order', () => {
  const products = [
    prod({ id: 'amz', 'Sort Order': 5, Network: 'amazon' }),
    prod({ id: 'dir', 'Sort Order': 5, Network: 'direct' }),
  ];
  const got = selectGear(products, { cut: 'half', stage: 'waiting' });
  assert.deepEqual(got.map((p) => p.id), ['dir', 'amz']);
});

// ── cap + empty ────────────────────────────────────────────────────────────────

test('caps at limit (default 4)', () => {
  const products = Array.from({ length: 6 }, (_, i) => prod({ id: `p${i}`, 'Sort Order': i }));
  assert.equal(selectGear(products, { cut: 'half', stage: 'waiting' }).length, 4);
  assert.equal(selectGear(products, { cut: 'half', stage: 'waiting', limit: 2 }).length, 2);
});

test('empty / null / zero-limit input → []', () => {
  assert.deepEqual(selectGear([], { cut: 'half', stage: 'waiting' }), []);
  assert.deepEqual(selectGear(null, { cut: 'half', stage: 'waiting' }), []);
  assert.deepEqual(selectGear(undefined, { cut: 'half', stage: 'waiting' }), []);
  assert.deepEqual(selectGear([prod({ id: 'x' })], { cut: 'half', stage: 'waiting', limit: 0 }), []);
});

// ── email compliance: drop amazon ──────────────────────────────────────────────

test('emailSafeGear DROPS amazon-network products (Amazon ToS)', () => {
  const products = [
    prod({ id: 'dir', Network: 'direct' }),
    prod({ id: 'amz', Network: 'amazon' }),
    prod({ id: 'AMZ-caps', Network: 'Amazon' }),
    prod({ id: 'blank', Network: '' }), // blank = non-amazon → kept
  ];
  const got = emailSafeGear(products);
  assert.deepEqual(got.map((p) => p.id).sort(), ['blank', 'dir']);
});

test('emailSafeGear: null → []', () => {
  assert.deepEqual(emailSafeGear(null), []);
  assert.deepEqual(emailSafeGear(undefined), []);
});
