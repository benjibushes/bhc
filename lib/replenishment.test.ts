// lib/replenishment.test.ts
//
// Selector tests for the replenishment cron (T2.3). Runner:
// JWT_SECRET=test-secret-ci npx tsx --test lib/replenishment.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cutReplenishDays,
  isReplenishEligible,
  isReplenishBuyerContactable,
  selectReplenishReferrals,
  REPLENISH_MAX_WINDOW_DAYS,
} from './replenishment';

const NOW_ISO = '2026-07-02T12:00:00.000Z';
const NOW = Date.parse(NOW_ISO);
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

const OPTS = { nowISO: NOW_ISO, batchCap: 25 };

function wonRef(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 'recWON00001',
    Status: 'Closed Won',
    'Sale Amount': 1800,
    'Order Type': 'Half Beef',
    'Closed At': daysAgo(200),
    ...overrides,
  };
}

// ── cut-aware thresholds ─────────────────────────────────────────────────────

test('cut thresholds: quarter 120d, half 180d, whole 300d, unknown 180d', () => {
  assert.equal(cutReplenishDays('Quarter Beef'), 120);
  assert.equal(cutReplenishDays('Half Beef'), 180);
  assert.equal(cutReplenishDays('Whole Beef'), 300);
  assert.equal(cutReplenishDays('Not Sure'), 180);
  assert.equal(cutReplenishDays(undefined), 180);
});

// ── eligibility ──────────────────────────────────────────────────────────────

test('eligible: Closed Won half, 200 days out, never nudged', () => {
  assert.equal(isReplenishEligible(wonRef(), OPTS), true);
});

test('NOT eligible before the cut threshold', () => {
  assert.equal(isReplenishEligible(wonRef({ 'Closed At': daysAgo(100) }), OPTS), false);
  // quarter threshold is earlier — the same 100-day age IS eligible
  assert.equal(
    isReplenishEligible(wonRef({ 'Order Type': 'Quarter Beef', 'Closed At': daysAgo(130) }), OPTS),
    true,
  );
});

test('NOT eligible past threshold + late window (stale deals skipped on go-live)', () => {
  const tooOld = 180 + REPLENISH_MAX_WINDOW_DAYS + 1;
  assert.equal(isReplenishEligible(wonRef({ 'Closed At': daysAgo(tooOld) }), OPTS), false);
});

test('NOT eligible: wrong status, zero sale, already nudged, corrupt stamp, unparseable close', () => {
  assert.equal(isReplenishEligible(wonRef({ Status: 'Awaiting Payment' }), OPTS), false);
  assert.equal(isReplenishEligible(wonRef({ 'Sale Amount': 0 }), OPTS), false);
  assert.equal(isReplenishEligible(wonRef({ 'Replenishment Nudged At': daysAgo(1) }), OPTS), false);
  // corrupt stamp counts as SENT — never storm
  assert.equal(isReplenishEligible(wonRef({ 'Replenishment Nudged At': 'garbage' }), OPTS), false);
  assert.equal(isReplenishEligible(wonRef({ 'Closed At': 'not-a-date' }), OPTS), false);
});

// ── buyer contactability ─────────────────────────────────────────────────────

test('buyer contactable: email + no suppression flags', () => {
  assert.equal(isReplenishBuyerContactable({ Email: 'a@b.com' }), true);
  assert.equal(isReplenishBuyerContactable({ Email: '' }), false);
  assert.equal(isReplenishBuyerContactable({ Email: 'a@b.com', Unsubscribed: true }), false);
  assert.equal(isReplenishBuyerContactable({ Email: 'a@b.com', Bounced: true }), false);
  assert.equal(isReplenishBuyerContactable({ Email: 'a@b.com', Complained: true }), false);
  assert.equal(isReplenishBuyerContactable(null), false);
});

// ── selection ────────────────────────────────────────────────────────────────

test('selects oldest close first and applies the cap', () => {
  const refs = [
    wonRef({ id: 'recNEWER', 'Closed At': daysAgo(190) }),
    wonRef({ id: 'recOLDEST', 'Closed At': daysAgo(300) }),
    wonRef({ id: 'recMID', 'Closed At': daysAgo(250) }),
    wonRef({ id: 'recTOOFRESH', 'Closed At': daysAgo(30) }),
  ];
  const picked = selectReplenishReferrals(refs, { ...OPTS, batchCap: 2 });
  assert.deepEqual(picked.map((r) => r.id), ['recOLDEST', 'recMID']);
});

test('empty input / zero cap select nothing', () => {
  assert.deepEqual(selectReplenishReferrals([], OPTS), []);
  assert.deepEqual(selectReplenishReferrals([wonRef()], { ...OPTS, batchCap: 0 }), []);
});
