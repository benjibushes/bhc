// lib/depositAbandonNudge.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/depositAbandonNudge.test.ts
//
// The deposit-ABANDON rail: quiz-complete deposit invites that were sent but
// never paid. Shares caps/cooldown with the rancher-request rail; disjoint by
// the empty-Deposit-Requested-At guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDepositAbandonEligible, selectDepositAbandonNudges } from './depositRequestNudge';

const NOW = Date.parse('2026-07-05T18:00:00.000Z');
const H = 3600_000;
const ago = (h: number) => new Date(NOW - h * H).toISOString();

const base = () => ({
  id: 'ref1',
  'Status': 'Intro Sent',
  'Deposit Invite Sent At': ago(30),   // 30h ago — past the 24h floor
  'Deposit Requested At': '',           // NOT a rancher request
  'Deposit Paid At': '',
  'Deposit Nudge Count': 0,
  'Deposit Nudge Last Sent At': '',
});

test('eligible: invite >24h, unpaid, non-terminal, no rancher request', () => {
  assert.equal(isDepositAbandonEligible(base(), NOW), true);
});

test('disjoint from rail A: a rancher-requested referral is NOT an abandon candidate', () => {
  assert.equal(isDepositAbandonEligible({ ...base(), 'Deposit Requested At': ago(40) }, NOW), false);
});

test('not eligible: already paid', () => {
  assert.equal(isDepositAbandonEligible({ ...base(), 'Deposit Paid At': ago(1) }, NOW), false);
});

test('not eligible: terminal statuses (Slot Locked / Closed Won / Closed Lost)', () => {
  for (const s of ['Slot Locked', 'Closed Won', 'Closed Lost']) {
    assert.equal(isDepositAbandonEligible({ ...base(), 'Status': s }, NOW), false, s);
  }
});

test('not eligible: invite younger than 24h', () => {
  assert.equal(isDepositAbandonEligible({ ...base(), 'Deposit Invite Sent At': ago(6) }, NOW), false);
});

test('not eligible: no invite stamp', () => {
  assert.equal(isDepositAbandonEligible({ ...base(), 'Deposit Invite Sent At': '' }, NOW), false);
});

test('cap: 2 nudges then permanent silence', () => {
  assert.equal(isDepositAbandonEligible({ ...base(), 'Deposit Nudge Count': 2 }, NOW), false);
  assert.equal(isDepositAbandonEligible({ ...base(), 'Deposit Nudge Count': 1, 'Deposit Nudge Last Sent At': ago(60) }, NOW), true);
});

test('cooldown: within 48h of last nudge → skip; corrupt stamp → skip (no storm)', () => {
  assert.equal(isDepositAbandonEligible({ ...base(), 'Deposit Nudge Count': 1, 'Deposit Nudge Last Sent At': ago(10) }, NOW), false);
  assert.equal(isDepositAbandonEligible({ ...base(), 'Deposit Nudge Count': 1, 'Deposit Nudge Last Sent At': 'not-a-date' }, NOW), false);
});

test('select: oldest invite first, capped', () => {
  const rows = [
    { ...base(), id: 'new', 'Deposit Invite Sent At': ago(25) },
    { ...base(), id: 'old', 'Deposit Invite Sent At': ago(90) },
    { ...base(), id: 'mid', 'Deposit Invite Sent At': ago(50) },
    { ...base(), id: 'paid', 'Deposit Paid At': ago(1) }, // excluded
  ];
  const out = selectDepositAbandonNudges(rows, { nowMs: NOW, batchCap: 2 });
  assert.deepEqual(out.map((r) => r.id), ['old', 'mid']);
});
