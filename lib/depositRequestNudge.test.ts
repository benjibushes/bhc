// lib/depositRequestNudge.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/depositRequestNudge.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDepositNudgeEligible,
  selectDepositNudges,
  DEPOSIT_NUDGE_LIFETIME_CAP,
} from './depositRequestNudge';

const NOW = Date.parse('2026-07-05T18:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(NOW - h * HOUR).toISOString();

function ref(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 'recDEP0001',
    Status: 'Awaiting Payment',
    ['Deposit Requested At']: hoursAgo(30),
    ...overrides,
  };
}

test('eligible: unpaid Awaiting Payment request older than 24h, no prior nudge', () => {
  assert.equal(isDepositNudgeEligible(ref(), NOW), true);
});

test('NOT eligible: paid (Deposit Paid At set)', () => {
  assert.equal(isDepositNudgeEligible(ref({ ['Deposit Paid At']: hoursAgo(1) }), NOW), false);
});

test('NOT eligible: no Deposit Requested At (not a rancher-sent request)', () => {
  assert.equal(isDepositNudgeEligible(ref({ ['Deposit Requested At']: '' }), NOW), false);
});

test('NOT eligible: status moved off Awaiting Payment (closed/refunded/rerouted)', () => {
  assert.equal(isDepositNudgeEligible(ref({ Status: 'Closed Lost' }), NOW), false);
  assert.equal(isDepositNudgeEligible(ref({ Status: 'Slot Locked' }), NOW), false);
  // singleSelect object shape too
  assert.equal(isDepositNudgeEligible(ref({ Status: { name: 'Refunded' } }), NOW), false);
});

test('NOT eligible: request younger than 24h (original email gets its shot)', () => {
  assert.equal(isDepositNudgeEligible(ref({ ['Deposit Requested At']: hoursAgo(6) }), NOW), false);
});

test('NOT eligible: lifetime cap reached', () => {
  assert.equal(
    isDepositNudgeEligible(ref({ ['Deposit Nudge Count']: DEPOSIT_NUDGE_LIFETIME_CAP }), NOW),
    false,
  );
});

test('cooldown: recent nudge blocks, old nudge allows (2nd nudge ~72h+)', () => {
  assert.equal(
    isDepositNudgeEligible(ref({ ['Deposit Nudge Count']: 1, ['Deposit Nudge Last Sent At']: hoursAgo(12) }), NOW),
    false,
  );
  assert.equal(
    isDepositNudgeEligible(
      ref({ ['Deposit Requested At']: hoursAgo(80), ['Deposit Nudge Count']: 1, ['Deposit Nudge Last Sent At']: hoursAgo(50) }),
      NOW,
    ),
    true,
  );
});

test('corrupt nudge stamp => skip (never storm)', () => {
  assert.equal(
    isDepositNudgeEligible(ref({ ['Deposit Nudge Last Sent At']: 'not-a-date' }), NOW),
    false,
  );
});

test('selector: oldest request first, batch cap respected, ineligible dropped', () => {
  const rows = [
    ref({ id: 'recNEW', ['Deposit Requested At']: hoursAgo(25) }),
    ref({ id: 'recOLD', ['Deposit Requested At']: hoursAgo(90) }),
    ref({ id: 'recPAID', ['Deposit Paid At']: hoursAgo(1) }),
    ref({ id: 'recMID', ['Deposit Requested At']: hoursAgo(50) }),
  ];
  const picked = selectDepositNudges(rows, { nowMs: NOW, batchCap: 2 });
  assert.deepEqual(picked.map((r) => r.id), ['recOLD', 'recMID']);
});

test('selector: empty input / zero cap => []', () => {
  assert.deepEqual(selectDepositNudges([], { nowMs: NOW }), []);
  assert.deepEqual(selectDepositNudges([ref()], { nowMs: NOW, batchCap: 0 }), []);
});
