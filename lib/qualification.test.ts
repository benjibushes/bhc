// lib/qualification.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/qualification.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQualificationFresh, isQualifiedForRouting, QUALIFICATION_FRESH_DAYS } from './qualification';

// ── isQualificationFresh (2026-07-06, conversion slice 2) ────────────────────
// "Qualified in April" is not "ready in July" — stale stamps block routing
// until the buyer one-clicks the re-confirm. Garbage/missing = NOT fresh
// (this gate only ever ADDS a stale-block; the base gate already excludes
// unqualified buyers).

test('isQualificationFresh: within window fresh, beyond stale, garbage stale', () => {
  const NOW = Date.parse('2026-07-06T12:00:00.000Z');
  const DAY = 86_400_000;
  assert.equal(isQualificationFresh(new Date(NOW - 3 * DAY).toISOString(), NOW), true);
  assert.equal(isQualificationFresh(new Date(NOW - (QUALIFICATION_FRESH_DAYS - 1) * DAY).toISOString(), NOW), true);
  assert.equal(isQualificationFresh(new Date(NOW - (QUALIFICATION_FRESH_DAYS + 1) * DAY).toISOString(), NOW), false);
  assert.equal(isQualificationFresh('', NOW), false);
  assert.equal(isQualificationFresh(null, NOW), false);
  assert.equal(isQualificationFresh('not-a-date', NOW), false);
});

// ── isQualifiedForRouting: explicit "Just exploring" TIMING hold (2026-07-15) ─
// /api/qualify's hold branch used to stamp Qualified At on explicitly-not-ready
// completers (234 legacy records). The routing gate must hold them even with
// the stamp present — timing self-ID beats the stamp.

function routableBuyer(over: Record<string, any> = {}): Record<string, any> {
  return {
    'Status': 'Approved',
    'Segment': 'Beef Buyer',
    'Order Type': 'Half',
    'Budget': '$4000-$5000',
    'Timing': 'Within 30 days',
    'Qualified At': '2026-07-14T00:00:00.000Z',
    'Qualification Score': 90,
    ...over,
  };
}

test('isQualifiedForRouting: Qualified At + concrete timing routes', () => {
  const q = isQualifiedForRouting(routableBuyer());
  assert.equal(q.ok, true);
  assert.equal(q.signal, 'qualified-quiz');
});

test('isQualifiedForRouting: "Just exploring" timing holds even with Qualified At stamped', () => {
  const q = isQualifiedForRouting(routableBuyer({ 'Timing': 'Just exploring' }));
  assert.equal(q.ok, false);
  assert.match(String(q.reason), /just exploring/i);
});

test('isQualifiedForRouting: "Just exploring" timing as stored singleSelect object also holds', () => {
  const q = isQualifiedForRouting(
    routableBuyer({ 'Timing': { name: 'Just exploring', id: 'selxOCa90wer3XV5Y' } }),
  );
  assert.equal(q.ok, false);
  assert.match(String(q.reason), /just exploring/i);
});

test('isQualifiedForRouting: empty timing does not hold (only the explicit self-ID does)', () => {
  const q = isQualifiedForRouting(routableBuyer({ 'Timing': '' }));
  assert.equal(q.ok, true);
});
