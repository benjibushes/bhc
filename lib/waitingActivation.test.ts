// lib/waitingActivation.test.ts
//
// Selector tests for the waiting-activation cron (Area A3). Written RED-first:
// selection, cooldown, lifetime cap, suppression, batch cap, ordering, empty
// input. Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/waitingActivation.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBuyerInSupply,
  isReadyChaseEligible,
  isWaitingNudgeEligible,
  parseNudgeKnob,
  selectReadyBuyersForChase,
  selectWaitingBuyersForNudge,
  READY_CHASE_MIN_STAMP_AGE_DAYS,
  READY_CHASE_NURTURE_DONE_TOUCH,
  READY_NUDGE_LIFETIME_CAP,
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

// ── funnel-completer exclusion (2026-07-22 audit) ────────────────────────────

test('NOT eligible: funnel completers held at WAITING stay in the nurture lane', () => {
  const held = buyer({ 'Funnel Completed At': daysAgo(5) });
  assert.equal(isWaitingNudgeEligible(held, OPTS), false);
  // blank / whitespace-only stamp still selects
  assert.equal(isWaitingNudgeEligible(buyer({ 'Funnel Completed At': '' }), OPTS), true);
  assert.equal(isWaitingNudgeEligible(buyer({ 'Funnel Completed At': '  ' }), OPTS), true);
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

// ── SUPPLY GATE (founder rule 2026-07-16) ────────────────────────────────────

test('supply gate: buyer in a served state selects; unserved state drops', () => {
  const supply = new Set(['MT', 'TX']);
  const mt = buyer({ id: 'recMT', State: 'MT' });
  const fl = buyer({ id: 'recFL', State: 'FL' });
  const picked = selectWaitingBuyersForNudge([mt, fl], { ...OPTS, supplyStates: supply });
  assert.deepEqual(picked.map((c) => c.id), ['recMT']);
});

test('supply gate: full state names normalize ("Montana" → MT)', () => {
  const supply = new Set(['MT']);
  const c = buyer({ State: 'Montana' });
  assert.equal(isBuyerInSupply(c, supply), true);
  assert.equal(selectWaitingBuyersForNudge([c], { ...OPTS, supplyStates: supply }).length, 1);
});

test('supply gate: blank or garbage State drops when gate is live', () => {
  const supply = new Set(['MT']);
  assert.equal(isBuyerInSupply(buyer({ State: '' }), supply), false);
  assert.equal(isBuyerInSupply(buyer({ State: 'Narnia' }), supply), false);
  assert.equal(isBuyerInSupply(buyer({}), supply), false);
});

test('supply gate: null/undefined set = gate off, everything passes', () => {
  assert.equal(isBuyerInSupply(buyer({ State: 'FL' }), null), true);
  assert.equal(isBuyerInSupply(buyer({ State: '' }), undefined), true);
  assert.equal(selectWaitingBuyersForNudge([buyer({ State: 'FL' })], OPTS).length, 1);
});

test('dry-run report: counts eligible buyers held back by the supply gate only', () => {
  const supply = new Set(['MT']);
  const candidates = [
    buyer({ id: 'recMT', State: 'MT' }),                        // selects
    buyer({ id: 'recFL', State: 'FL' }),                        // held: supply only
    buyer({ id: 'recAZ', State: 'AZ', Unsubscribed: true }),    // ineligible anyway — NOT counted
  ];
  const selected = selectWaitingBuyersForNudge(candidates, { ...OPTS, supplyStates: supply });
  const report = buildWaitingDryRunReport(candidates, selected, {
    nowISO: NOW_ISO,
    cooldownDays: OPTS.cooldownDays,
    supplyStates: supply,
  });
  assert.equal(report.selectedCount, 1);
  assert.equal(report.droppedNoSupply, 1);
  assert.deepEqual(report.supplyStates, ['MT']);
  const text = formatWaitingDryRunReport(report, { cooldownDays: 14, batchCap: 50 });
  assert.match(text, /Supply gate: MT/);
  assert.match(text, /held back 1/);
});

test('dry-run report: gate off → supplyStates null, droppedNoSupply 0', () => {
  const report = buildWaitingDryRunReport([buyer({ State: 'FL' })], [], { nowISO: NOW_ISO });
  assert.equal(report.supplyStates, null);
  assert.equal(report.droppedNoSupply, 0);
  const text = formatWaitingDryRunReport(report, { cooldownDays: 14, batchCap: 50 });
  assert.match(text, /Supply gate: OFF/);
});

// ── parseNudgeKnob (0-honoring env parse, 2026-07-22 audit) ──────────────────

test('parseNudgeKnob: explicit 0 is honored (the mid-incident pause move)', () => {
  assert.equal(parseNudgeKnob('0', 50), 0);
});

test('parseNudgeKnob: unset / blank / junk / negative fall back to the default', () => {
  assert.equal(parseNudgeKnob(undefined, 50), 50);
  assert.equal(parseNudgeKnob('', 50), 50);
  assert.equal(parseNudgeKnob('   ', 50), 50);
  assert.equal(parseNudgeKnob('banana', 50), 50);
  assert.equal(parseNudgeKnob('-5', 50), 50);
});

test('parseNudgeKnob: ordinary positive values parse', () => {
  assert.equal(parseNudgeKnob('25', 50), 25);
  assert.equal(parseNudgeKnob('7', 14), 7);
});

// ── READY chase (2026-07-22 audit) ───────────────────────────────────────────

// Minimal well-formed READY funnel-completer past nurture; overrides build
// the edge cases.
function readyBuyer(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 'recREADY001',
    'Buyer Stage': 'READY',
    Email: 'ready@example.com',
    'Qualified At': daysAgo(30),
    'Nurture Touch': READY_CHASE_NURTURE_DONE_TOUCH,
    _createdTime: daysAgo(60),
    ...overrides,
  };
}

test('ready chase: eligible base case (READY, qualified, nurture done)', () => {
  assert.equal(isReadyChaseEligible(readyBuyer(), OPTS), true);
});

test('ready chase NOT eligible: wrong stage, no email, suppression trio', () => {
  assert.equal(isReadyChaseEligible(readyBuyer({ 'Buyer Stage': 'WAITING' }), OPTS), false);
  assert.equal(isReadyChaseEligible(readyBuyer({ 'Buyer Stage': 'MATCHED' }), OPTS), false);
  assert.equal(isReadyChaseEligible(readyBuyer({ Email: '' }), OPTS), false);
  assert.equal(isReadyChaseEligible(readyBuyer({ Unsubscribed: true }), OPTS), false);
  assert.equal(isReadyChaseEligible(readyBuyer({ Bounced: true }), OPTS), false);
  assert.equal(isReadyChaseEligible(readyBuyer({ Complained: true }), OPTS), false);
});

test('ready chase: requires Qualified At OR Funnel Completed At', () => {
  assert.equal(isReadyChaseEligible(readyBuyer({ 'Qualified At': '' }), OPTS), false);
  assert.equal(
    isReadyChaseEligible(readyBuyer({ 'Qualified At': '', 'Funnel Completed At': daysAgo(30) }), OPTS),
    true,
  );
});

test('ready chase: starts only after nurture ends (touch >= 4 OR stamp >= 25d old)', () => {
  // nurture not done + fresh stamp → too early
  const early = readyBuyer({ 'Nurture Touch': 2, 'Qualified At': daysAgo(10) });
  assert.equal(isReadyChaseEligible(early, OPTS), false);
  // nurture not done but stamp is old enough → drip window has passed
  const oldStamp = readyBuyer({
    'Nurture Touch': 2,
    'Qualified At': daysAgo(READY_CHASE_MIN_STAMP_AGE_DAYS + 1),
  });
  assert.equal(isReadyChaseEligible(oldStamp, OPTS), true);
  // no Nurture Touch field at all (never dripped) + old stamp → eligible
  const noTouch = readyBuyer({ 'Nurture Touch': undefined, 'Qualified At': daysAgo(40) });
  assert.equal(isReadyChaseEligible(noTouch, OPTS), true);
  // no Nurture Touch + fresh stamp → too early
  const noTouchFresh = readyBuyer({ 'Nurture Touch': undefined, 'Qualified At': daysAgo(5) });
  assert.equal(isReadyChaseEligible(noTouchFresh, OPTS), false);
});

test('ready chase: lifetime cap on Ready Nudge Count', () => {
  assert.equal(READY_NUDGE_LIFETIME_CAP, 3);
  const capped = readyBuyer({ 'Ready Nudge Count': 3, 'Ready Nudge Last Sent At': daysAgo(60) });
  const twoIn = readyBuyer({ 'Ready Nudge Count': 2, 'Ready Nudge Last Sent At': daysAgo(60) });
  assert.equal(isReadyChaseEligible(capped, OPTS), false);
  assert.equal(isReadyChaseEligible(twoIn, OPTS), true);
});

test('ready chase: cooldown on Ready Nudge Last Sent At; corrupt stamp skips', () => {
  assert.equal(isReadyChaseEligible(readyBuyer({ 'Ready Nudge Last Sent At': daysAgo(13) }), OPTS), false);
  assert.equal(isReadyChaseEligible(readyBuyer({ 'Ready Nudge Last Sent At': daysAgo(15) }), OPTS), true);
  assert.equal(isReadyChaseEligible(readyBuyer({ 'Ready Nudge Last Sent At': 'not-a-date' }), OPTS), false);
});

test('ready chase selector: excludes buyers with a live referral', () => {
  const a = readyBuyer({ id: 'recActive' });
  const b = readyBuyer({ id: 'recFree' });
  const picked = selectReadyBuyersForChase([a, b], {
    ...OPTS,
    activeBuyerIds: new Set(['recActive']),
  });
  assert.deepEqual(picked.map((c) => c.id), ['recFree']);
});

test('ready chase selector: supply gate + oldest-first ordering + batch cap', () => {
  const supply = new Set(['MT']);
  const consumers = [
    readyBuyer({ id: 'recNEW', State: 'MT', _createdTime: daysAgo(30) }),
    readyBuyer({ id: 'recOLD', State: 'MT', _createdTime: daysAgo(300) }),
    readyBuyer({ id: 'recFL', State: 'FL', _createdTime: daysAgo(500) }),
    readyBuyer({ id: 'recMID', State: 'MT', _createdTime: daysAgo(90) }),
  ];
  const picked = selectReadyBuyersForChase(consumers, {
    ...OPTS,
    batchCap: 2,
    supplyStates: supply,
  });
  assert.deepEqual(picked.map((c) => c.id), ['recOLD', 'recMID']);
});

test('ready chase selector: batchCap 0 or empty input selects nothing', () => {
  assert.deepEqual(selectReadyBuyersForChase([readyBuyer()], { ...OPTS, batchCap: 0 }), []);
  assert.deepEqual(selectReadyBuyersForChase([], OPTS), []);
});
