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

// ── dry-run report (T2.1, 2026-07-02) ────────────────────────────────────────

import { buildWaitingDryRunReport, formatWaitingDryRunReport } from './waitingActivation';

test('dry-run report: counts pool, selected, states, prior nudges, sms-eligible', () => {
  const candidates = [
    buyer({ id: 'recA', State: 'TX', _createdTime: daysAgo(200) }),
    buyer({ id: 'recB', State: 'TX', 'SMS Opt-In': true, Phone: '+14065551212', _createdTime: daysAgo(100) }),
    buyer({ id: 'recC', State: 'CA', 'Waiting Nudge Count': 1, _createdTime: daysAgo(50) }),
    buyer({ id: 'recD', _createdTime: daysAgo(10) }), // no state
  ];
  const selected = selectWaitingBuyersForNudge(candidates, { ...OPTS, batchCap: 3 });
  const report = buildWaitingDryRunReport(candidates, selected, { nowISO: NOW_ISO });
  assert.equal(report.poolSize, 4);
  assert.equal(report.selectedCount, 3); // oldest 3: A, B, C
  assert.deepEqual(report.byState, { TX: 2, CA: 1 });
  assert.deepEqual(report.byPriorNudges, { '0': 2, '1': 1 });
  assert.equal(report.smsEligibleCount, 1); // only recB has opt-in + phone
  assert.equal(report.oldestSignupDays, 200);
});

test('dry-run report: SMS-eligible requires opt-in AND phone AND not unsubscribed', () => {
  const sel = [
    buyer({ id: 'r1', 'SMS Opt-In': true }), // no phone
    buyer({ id: 'r2', Phone: '+14065551212' }), // no opt-in
    buyer({ id: 'r3', 'SMS Opt-In': true, Phone: '+14065551212' }),
  ];
  const report = buildWaitingDryRunReport(sel, sel, { nowISO: NOW_ISO });
  assert.equal(report.smsEligibleCount, 1);
});

test('dry-run report: sample capped and carries id/state/age/prior fields', () => {
  const selected = Array.from({ length: 15 }, (_, i) =>
    buyer({ id: `rec${i}`, State: 'MT', _createdTime: daysAgo(30 + i) }),
  );
  const report = buildWaitingDryRunReport(selected, selected, { nowISO: NOW_ISO, sampleSize: 5 });
  assert.equal(report.sample.length, 5);
  assert.equal(report.sample[0].id, 'rec0');
  assert.equal(report.sample[0].state, 'MT');
  assert.equal(report.sample[0].signedUpDaysAgo, 30);
  assert.equal(report.sample[0].priorNudges, 0);
});

test('dry-run report: empty selection → zeroed report, null oldest', () => {
  const report = buildWaitingDryRunReport([], [], { nowISO: NOW_ISO });
  assert.equal(report.poolSize, 0);
  assert.equal(report.selectedCount, 0);
  assert.equal(report.oldestSignupDays, null);
  assert.deepEqual(report.sample, []);
});

test('dry-run formatter: carries the load-bearing numbers + go-live instruction', () => {
  const candidates = [
    buyer({ id: 'recA', State: 'TX', 'Full Name': 'Kasey Jones', _createdTime: daysAgo(200) }),
  ];
  const report = buildWaitingDryRunReport(candidates, candidates, { nowISO: NOW_ISO });
  const text = formatWaitingDryRunReport(report, { cooldownDays: 14, batchCap: 50 });
  assert.match(text, /DRY RUN/);
  assert.match(text, /no sends, no stamps/i);
  assert.match(text, /Pool: 1/);
  assert.match(text, /Would nudge this run: 1/);
  assert.match(text, /cap 50/);
  assert.match(text, /cooldown 14d/);
  assert.match(text, /TX/);
  assert.match(text, /WAITING_ACTIVATION_ENABLED=true/);
  assert.match(text, /Kasey/);
  assert.doesNotMatch(text, /undefined/);
});
