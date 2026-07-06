// lib/leadGrade.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/leadGrade.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuizSignals, gradeLead, gradeSortWeight, FRESH_DAYS, STALE_DAYS } from './leadGrade';

const NOW = Date.parse('2026-07-06T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

// Real production shape (Dana's referral, 2026-07-03):
const DANA_NOTES =
  '[NRD-accept 2026-07-04T06:52] Beckie Elway confirmed processing slot. \n' +
  '[QUIZ 2026-07-03T16:52:27.678Z] tier=Half timing=Within 60 days storage=have_freezer ack=true score=90/100';

test('parseQuizSignals: parses the real production quiz line', () => {
  const q = parseQuizSignals(DANA_NOTES);
  assert.equal(q.score, 90);
  assert.equal(q.timingSoon, true);
  assert.equal(q.hasFreezer, true);
  assert.equal(q.budgetAck, true);
});

test('parseQuizSignals: tolerant of missing line / garbage', () => {
  assert.deepEqual(parseQuizSignals(''), { score: null, timingSoon: false, hasFreezer: false, budgetAck: false });
  assert.deepEqual(parseQuizSignals(null), { score: null, timingSoon: false, hasFreezer: false, budgetAck: false });
  assert.equal(parseQuizSignals('[QUIZ x] junk with no keys').score, null);
});

test('parseQuizSignals: later timing is NOT soon', () => {
  const q = parseQuizSignals('[QUIZ t] tier=Half timing=3-6 months storage=no_freezer ack=false score=76/100');
  assert.equal(q.timingSoon, false);
  assert.equal(q.hasFreezer, false);
  assert.equal(q.budgetAck, false);
  assert.equal(q.score, 76);
});

test('grade A: opened deposit page (unpaid) — the hottest signal wins alone', () => {
  const g = gradeLead({ notes: '', createdAt: daysAgo(60), depositLinkOpenedAt: daysAgo(1), nowMs: NOW });
  assert.equal(g?.grade, 'A');
  assert.ok(g!.reasons[0].includes('deposit page'));
});

test('grade A: Dana-class — high score + timing-soon + fresh', () => {
  const g = gradeLead({ notes: DANA_NOTES, createdAt: daysAgo(3), nowMs: NOW });
  assert.equal(g?.grade, 'A');
});

test('grade B: solid 75+ but not Dana-class (timing later or older)', () => {
  const notes = '[QUIZ t] tier=Half timing=3-6 months storage=have_freezer ack=true score=80/100';
  const g = gradeLead({ notes, createdAt: daysAgo(10), nowMs: NOW });
  assert.equal(g?.grade, 'B');
});

test('grade boundary: high score + soon but AGED past fresh → B not A', () => {
  const g = gradeLead({ notes: DANA_NOTES, createdAt: daysAgo(FRESH_DAYS + 5), nowMs: NOW });
  assert.equal(g?.grade, 'B');
});

test('grade C: stale (> STALE_DAYS) regardless of score; and unparseable quiz', () => {
  const g1 = gradeLead({ notes: DANA_NOTES, createdAt: daysAgo(STALE_DAYS + 10), nowMs: NOW });
  assert.equal(g1?.grade, 'C');
  const g2 = gradeLead({ notes: 'no quiz line here', createdAt: daysAgo(2), nowMs: NOW });
  assert.equal(g2?.grade, 'C');
});

test('paid buyers are not graded (null)', () => {
  assert.equal(gradeLead({ notes: DANA_NOTES, createdAt: daysAgo(1), depositPaidAt: daysAgo(0), nowMs: NOW }), null);
});

test('sort weight: A < B < C, null sinks last', () => {
  assert.ok(gradeSortWeight('A') < gradeSortWeight('B'));
  assert.ok(gradeSortWeight('B') < gradeSortWeight('C'));
  assert.equal(gradeSortWeight(null), 2);
});
