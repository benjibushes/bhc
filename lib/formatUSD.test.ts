import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatUSD } from './formatUSD';

// Wave 1A (2026-08-01): the one rancher-surface money format. The pinned
// behaviors below are the exact renders the dashboard shipped wrong before
// this helper existed ("$2,999.5") — keep them locked.

test('whole dollars render without cents noise', () => {
  assert.equal(formatUSD(2999), '$2,999');
  assert.equal(formatUSD(0), '$0');
  assert.equal(formatUSD(150), '$150');
});

test('real cents always render as TWO digits — never "$2,999.5"', () => {
  assert.equal(formatUSD(2999.5), '$2,999.50');
  assert.equal(formatUSD(0.5), '$0.50');
  assert.equal(formatUSD(1234.56), '$1,234.56');
});

test('sub-cent float dust is rounded away, not printed', () => {
  assert.equal(formatUSD(0.1 + 0.2), '$0.30'); // 0.30000000000000004
  assert.equal(formatUSD(2999.999), '$3,000');
});

test('thousands separators on large values', () => {
  assert.equal(formatUSD(1250000), '$1,250,000');
  assert.equal(formatUSD(10000.25), '$10,000.25');
});

test('negative amounts carry the sign outside the $', () => {
  assert.equal(formatUSD(-12.5), '-$12.50');
  assert.equal(formatUSD(-100), '-$100');
});

test('non-finite garbage degrades to $0, never NaN on a money surface', () => {
  assert.equal(formatUSD(NaN), '$0');
  assert.equal(formatUSD(Infinity), '$0');
  assert.equal(formatUSD(undefined as unknown as number), '$0');
});
