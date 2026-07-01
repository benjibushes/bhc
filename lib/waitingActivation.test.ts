// lib/waitingActivation.test.ts
//
// Selector tests for the waiting-activation cron (Area A3). Written RED-first:
// selection, cooldown, lifetime cap, suppression, batch cap, ordering, empty
// input. Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/waitingActivation.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWaitingNudgeEligible,
  selectWaitingBuyersForNudge,
  WAITING_NUDGE_LIFETIME_CAP,
} from './waitingActivation';

const NOW_ISO = '2026-07-01T12:00:00.000Z';
const NOW = Date.parse(NOW_ISO);
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

const OPTS = { nowISO: NOW_ISO, cooldownDays: 14, batchCap: 25 };

// Minimal well-formed WAITING consumer; overrides build the edge cases.
function buyer(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 'recWAIT0001',
    'Buyer Stage': 'WAITING',
    Email: 'buyer@example.com',
    _createdTime: daysAgo(30),
    ...overrides,
  };
}

// ── basic selection ──────────────────────────────────────────────────────────

test('selects a WAITING buyer with an email and no prior nudge', () => {
  assert.equal(isWaitingNudgeEligible(buyer(), OPTS), true);
  assert.equal(selectWaitingBuyersForNudge([buyer()], OPTS).length, 1);
});

test('NOT eligible: Buyer Stage is not WAITING', () => {
  assert.equal(isWaitingNudgeEligible(buyer({ 'Buyer Stage': 'MATCHED' }), OPTS), false);
  assert.equal(isWaitingNudgeEligible(buyer({ 'Buyer Stage': 'CLOSED' }), OPTS), false);
  assert.equal(isWaitingNudgeEligible(buyer({ 'Buyer Stage': undefined }), OPTS), false);
});

test('NOT eligible: missing or blank email', () => {
  assert.equal(isWaitingNudgeEligible(buyer({ Email: '' }), OPTS), false);
  assert.equal(isWaitingNudgeEligible(buyer({ Email: '   ' }), OPTS), false);
  assert.equal(isWaitingNudgeEligible(buyer({ Email: undefined }), OPTS), false);
});

// ── suppression (repo convention: Unsubscribed / Bounced / Complained) ──────

test('NOT eligible: suppressed via Unsubscribed / Bounced / Complained', () => {
  assert.equal(isWaitingNudgeEligible(buyer({ Unsubscribed: true }), OPTS), false);
  assert.equal(isWaitingNudgeEligible(buyer({ Bounced: true }), OPTS), false);
  assert.equal(isWaitingNudgeEligible(buyer({ Complained: true }), OPTS), false);
});

// ── cooldown on Waiting Nudge Last Sent At ───────────────────────────────────

test('cooldown: nudged inside the window is skipped; outside is eligible', () => {
  const recent = buyer({ 'Waiting Nudge Last Sent At': daysAgo(13) });
  const old = buyer({ 'Waiting Nudge Last Sent At': daysAgo(15) });
  assert.equal(isWaitingNudgeEligible(recent, OPTS), false);
  assert.equal(isWaitingNudgeEligible(old, OPTS), true);
});

test('cooldown boundary: exactly cooldownDays ago is eligible', () => {
  const atBoundary = buyer({ 'Waiting Nudge Last Sent At': daysAgo(14) });
  assert.equal(isWaitingNudgeEligible(atBoundary, OPTS), true);
});

test('cooldown: unparseable non-empty stamp is skipped (conservative — never storm)', () => {
  const garbled = buyer({ 'Waiting Nudge Last Sent At': 'not-a-date' });
  assert.equal(isWaitingNudgeEligible(garbled, OPTS), false);
});

// ── lifetime cap on Waiting Nudge Count ──────────────────────────────────────

test('lifetime cap: 3 prior nudges = done forever; 2 is still eligible', () => {
  assert.equal(WAITING_NUDGE_LIFETIME_CAP, 3);
  const capped = buyer({ 'Waiting Nudge Count': 3, 'Waiting Nudge Last Sent At': daysAgo(60) });
  const twoIn = buyer({ 'Waiting Nudge Count': 2, 'Waiting Nudge Last Sent At': daysAgo(60) });
  assert.equal(isWaitingNudgeEligible(capped, OPTS), false);
  assert.equal(isWaitingNudgeEligible(twoIn, OPTS), true);
});

test('lifetime cap tolerates typecast strings and treats junk as zero', () => {
  const cappedStr = buyer({ 'Waiting Nudge Count': '3', 'Waiting Nudge Last Sent At': daysAgo(60) });
  const junk = buyer({ 'Waiting Nudge Count': 'n/a' });
  assert.equal(isWaitingNudgeEligible(cappedStr, OPTS), false);
  assert.equal(isWaitingNudgeEligible(junk, OPTS), true);
});

// ── batch cap + oldest-first ordering ────────────────────────────────────────

test('batch cap limits the run and keeps the OLDEST signups first', () => {
  const consumers = [
    buyer({ id: 'recNEW', _createdTime: daysAgo(1) }),
    buyer({ id: 'recOLDEST', _createdTime: daysAgo(400) }),
    buyer({ id: 'recMID', _createdTime: daysAgo(90) }),
    buyer({ id: 'recOLD', _createdTime: daysAgo(200) }),
  ];
  const picked = selectWaitingBuyersForNudge(consumers, { ...OPTS, batchCap: 2 });
  assert.deepEqual(picked.map((c) => c.id), ['recOLDEST', 'recOLD']);
});

test('selector filters ineligible rows before applying the batch cap', () => {
  const consumers = [
    buyer({ id: 'recSUPPRESSED', Unsubscribed: true, _createdTime: daysAgo(500) }),
    buyer({ id: 'recA', _createdTime: daysAgo(300) }),
    buyer({ id: 'recB', _createdTime: daysAgo(100) }),
  ];
  const picked = selectWaitingBuyersForNudge(consumers, { ...OPTS, batchCap: 2 });
  assert.deepEqual(picked.map((c) => c.id), ['recA', 'recB']);
});

test('batchCap of 0 or negative selects nothing', () => {
  assert.deepEqual(selectWaitingBuyersForNudge([buyer()], { ...OPTS, batchCap: 0 }), []);
  assert.deepEqual(selectWaitingBuyersForNudge([buyer()], { ...OPTS, batchCap: -5 }), []);
});

// ── empty input ──────────────────────────────────────────────────────────────

test('empty input returns an empty selection', () => {
  assert.deepEqual(selectWaitingBuyersForNudge([], OPTS), []);
});
