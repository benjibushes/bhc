// lib/sourceQuality.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/sourceQuality.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceQualityRates } from './sourceQuality';

test('sourceQualityRates: normal funnel', () => {
  const r = sourceQualityRates({ signups: 100, qualified: 40, matches: 30, depositsPaid: 8, closes: 5 });
  assert.equal(r.qualifiedRate, 0.4);
  assert.equal(r.payRate, 0.08);
  assert.equal(r.qualifiedToPaidRate, 0.2);
});

test('sourceQualityRates: zero signups → all null (renders "—", never NaN)', () => {
  const r = sourceQualityRates({ signups: 0, qualified: 0, matches: 0, depositsPaid: 0, closes: 0 });
  assert.equal(r.qualifiedRate, null);
  assert.equal(r.payRate, null);
  assert.equal(r.qualifiedToPaidRate, null);
});

test('sourceQualityRates: signups but zero qualified → qualifiedToPaidRate null, others 0', () => {
  const r = sourceQualityRates({ signups: 50, qualified: 0, matches: 0, depositsPaid: 0, closes: 0 });
  assert.equal(r.qualifiedRate, 0);
  assert.equal(r.payRate, 0);
  assert.equal(r.qualifiedToPaidRate, null);
});

test('sourceQualityRates: top-leak vs middle-leak are distinguishable', () => {
  // Top-leak: bad targeting — few qualify at all.
  const topLeak = sourceQualityRates({ signups: 100, qualified: 5, matches: 4, depositsPaid: 3, closes: 3 });
  // Middle-leak: good targeting, but they don't convert to money.
  const midLeak = sourceQualityRates({ signups: 100, qualified: 80, matches: 60, depositsPaid: 2, closes: 2 });
  assert.ok(topLeak.qualifiedRate! < midLeak.qualifiedRate!); // top-leak qualifies fewer
  assert.ok(topLeak.qualifiedToPaidRate! > midLeak.qualifiedToPaidRate!); // but converts survivors better
});

test('sourceQualityRates: guards against garbage', () => {
  const r = sourceQualityRates({ signups: NaN as any, qualified: 5, matches: 0, depositsPaid: 1, closes: 0 });
  assert.equal(r.qualifiedRate, null);
  assert.equal(r.payRate, null);
});
