// lib/brokerDepositChase.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/brokerDepositChase.test.ts
//
// BROKER DEPOSIT CHASE LANE (Wave 1 F5, 2026-08-18). On the broker rail the
// deposit IS 100% of BHC's revenue on the sale — and the two rails that chase
// unpaid deposits both structurally exclude broker rows:
//
//   • rail A keys on Status='Awaiting Payment' — Connect request machinery a
//     broker row never enters (broker rows are 'Intro Sent' / 'Pending');
//   • rail B keys on {Deposit Requested At}="" — but app/api/checkout/broker
//     stamps 'Deposit Requested At' at SESSION MINT ("we asked for this money
//     on this rail"), so the highest-intent broker buyer — one who opened the
//     checkout and abandoned at Stripe — is ejected from rail B forever.
//
// This lane's cohort (per the live-verified audit): broker marker (the shared
// lib/brokerDownstream predicate, never a new string match) + Status 'Intro
// Sent' + no 'Deposit Paid At' + invite stamped. The invite stamp is the
// DELIVERED-ask bar (post-#639 send-truth: matching/suggest only stamps
// 'Deposit Invite Sent At' when the broker invite actually sent) — a chase
// that references "your reservation" must never follow an ask that never
// landed (qualified-no-action owns that cohort, 30min-4h).
//
// Cadence: the SAME planner + stamps as rail B ('deposit-invite' tiered
// window, 'Deposit Nudge Count' / 'Deposit Nudge Last Sent At'), so a row
// that both rails can see (requested-empty broker row) gets ONE consistent
// arc whichever selector picks it, and the suppressed sentinel (99) retires
// it from this lane exactly like the others.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  brokerDepositChasePlan,
  isBrokerDepositChaseEligible,
  selectBrokerDepositChase,
  isDepositAbandonEligible,
  isDepositNudgeEligible,
  DEPOSIT_NUDGE_SUPPRESSED_SENTINEL,
} from './depositRequestNudge';
import { BROKER_MATCH_TYPE } from './brokerRail';

const NOW = Date.parse('2026-08-18T18:00:00.000Z');
const H = 3600_000;
const ago = (h: number) => new Date(NOW - h * H).toISOString();

// The post-broker-match shape: marker + Intro Sent + delivered invite, unpaid.
const base = () => ({
  id: 'refBroker1',
  'Match Type': BROKER_MATCH_TYPE,
  'Status': 'Intro Sent',
  'Deposit Invite Sent At': ago(30), // 30h — past the planner's day-1 offset
  'Deposit Requested At': '',
  'Deposit Paid At': '',
  'Deposit Nudge Count': 0,
  'Deposit Nudge Last Sent At': '',
});

// ── The lane exists and chases the cohort ───────────────────────────────────

test('BROKER LANE: a matched broker row with a delivered ask and no deposit is chased', () => {
  assert.equal(isBrokerDepositChaseEligible(base(), NOW), true);
});

test('BROKER LANE (the F5 eject bug): a stamped Deposit Requested At does NOT eject the row', () => {
  // app/api/checkout/broker stamps 'Deposit Requested At' when the buyer
  // MINTS a checkout session. Rail B ejects on that stamp ({Deposit Requested
  // At}=""), rail A never matches (Status stays 'Intro Sent') — so before this
  // lane, the buyer who got closest to paying was the only one never chased.
  const row = { ...base(), 'Deposit Requested At': ago(20) };
  assert.equal(isDepositAbandonEligible(row, NOW), false, 'rail B must still eject (its invariant)');
  assert.equal(isDepositNudgeEligible(row, NOW), false, 'rail A must still not match (wrong status)');
  assert.equal(isBrokerDepositChaseEligible(row, NOW), true, 'the broker lane must chase it');
});

test('BROKER LANE: overlap rows (requested-empty) plan identically to rail B — one arc, either selector', () => {
  // Same planner, same stamps: whichever selector picks the row first, the
  // touch cadence is the same, so the id-dedupe in the cron can never skew it.
  const row = base();
  assert.equal(isDepositAbandonEligible(row, NOW), isBrokerDepositChaseEligible(row, NOW));
  const later = { ...row, 'Deposit Nudge Count': 1, 'Deposit Nudge Last Sent At': ago(2) };
  assert.equal(isDepositAbandonEligible(later, NOW), isBrokerDepositChaseEligible(later, NOW));
});

// ── Both directions: what the lane must NEVER touch ─────────────────────────

test('CONNECT UNCHANGED: a Connect row of identical shape is invisible to this lane', () => {
  for (const matchType of ['', 'Nearest Rancher', undefined]) {
    const row: any = { ...base() };
    if (matchType === undefined) delete row['Match Type'];
    else row['Match Type'] = matchType;
    assert.equal(brokerDepositChasePlan(row, NOW), null, `Match Type=${JSON.stringify(matchType)}`);
  }
});

test('DELIVERED-ASK BAR: no invite stamp (send failed, #639 left it blank on purpose) → no chase', () => {
  assert.equal(brokerDepositChasePlan({ ...base(), 'Deposit Invite Sent At': '' }, NOW), null);
});

test('status gate: only Intro Sent — Pending (self-serve, no delivered ask) and terminal rows stay out', () => {
  for (const s of ['Pending', 'Pending Approval', 'Slot Locked', 'Closed Won', 'Closed Lost', 'Awaiting Payment']) {
    assert.equal(brokerDepositChasePlan({ ...base(), 'Status': s }, NOW), null, s);
  }
});

test('paid rows are done — the deposit (the whole fee) already landed', () => {
  assert.equal(brokerDepositChasePlan({ ...base(), 'Deposit Paid At': ago(1) }, NOW), null);
});

test('SUPPRESSED SENTINEL: count 99 retires the row from this lane like every other', () => {
  const row = {
    ...base(),
    'Deposit Nudge Count': DEPOSIT_NUDGE_SUPPRESSED_SENTINEL,
    'Deposit Nudge Last Sent At': ago(3),
  };
  const plan = brokerDepositChasePlan(row, NOW);
  assert.equal(plan?.due, false);
  assert.equal(plan?.exhausted, true, 'sentinel must read as exhausted, not merely not-due');
});

test('lifetime bound: 6 touches (5 sprint + 1 decay) then permanent silence', () => {
  const row = {
    ...base(),
    'Deposit Invite Sent At': ago(16 * 24),
    'Deposit Nudge Count': 6,
    'Deposit Nudge Last Sent At': ago(30),
  };
  const plan = brokerDepositChasePlan(row, NOW);
  assert.equal(plan?.due, false);
  assert.equal(plan?.exhausted, true);
});

test('cadence: inside the current ramp gap → not due; corrupt last-sent stamp → fail closed (null)', () => {
  // Touch 1 went out 1h ago (day-1 offset). Next offset is day 3 — not due.
  const inGap = { ...base(), 'Deposit Nudge Count': 1, 'Deposit Nudge Last Sent At': ago(1) };
  assert.equal(isBrokerDepositChaseEligible(inGap, NOW), false);
  const corrupt = { ...base(), 'Deposit Nudge Count': 1, 'Deposit Nudge Last Sent At': 'not-a-date' };
  assert.equal(brokerDepositChasePlan(corrupt, NOW), null, 'corrupt stamp must never storm');
});

test('unparseable invite stamp fails closed', () => {
  assert.equal(brokerDepositChasePlan({ ...base(), 'Deposit Invite Sent At': 'garbage' }, NOW), null);
});

// ── Selection ───────────────────────────────────────────────────────────────

test('select: oldest delivered ask first (it leaks first), capped', () => {
  const rows = [
    { ...base(), id: 'young', 'Deposit Invite Sent At': ago(26) },
    { ...base(), id: 'old', 'Deposit Invite Sent At': ago(80) },
    { ...base(), id: 'mid', 'Deposit Invite Sent At': ago(50) },
    { ...base(), id: 'connect', 'Match Type': '' },
  ];
  const picked = selectBrokerDepositChase(rows, { nowMs: NOW, batchCap: 2 });
  assert.deepEqual(picked.map((r) => r.id), ['old', 'mid']);
});

test('select: empty input / zero cap → empty, never throws', () => {
  assert.deepEqual(selectBrokerDepositChase([], { nowMs: NOW }), []);
  assert.deepEqual(selectBrokerDepositChase([base()], { nowMs: NOW, batchCap: 0 }), []);
});
