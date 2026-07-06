// lib/qualification.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/qualification.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQualificationFresh, QUALIFICATION_FRESH_DAYS } from './qualification';

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
