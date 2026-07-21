// lib/depositWatchdog.test.ts
//
// Pure selection tests for the deposit-watchdog half-state detector (1b).
// Run: JWT_SECRET=test-secret-ci npx tsx --test lib/depositWatchdog.test.ts
//
// The invariant under test: alert ONLY on referrals that are
// Awaiting Payment + never paid + never invited + older than 2h (on a
// PARSEABLE anchor) + outside the 24h re-alert cooldown. Everything else —
// especially PAID deals, which keep Status='Awaiting Payment' — is excluded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectWatchdogTargets,
  isWatchdogTarget,
  watchdogSkipReason,
  watchdogAnchorMs,
  WATCHDOG_MIN_AGE_MS,
  WATCHDOG_COOLDOWN_MS,
} from './depositWatchdog';

const NOW = new Date('2026-07-21T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const hoursAgo = (h: number) => new Date(NOW_MS - h * 60 * 60 * 1000).toISOString();

function baseTarget(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'recWatchdog1',
    Status: 'Awaiting Payment',
    'Deposit Requested At': hoursAgo(3),
    _createdTime: hoursAgo(48),
    ...overrides,
  };
}

// ── the half-state fires ────────────────────────────────────────────────────

test('Awaiting Payment + no paid + no invite + 3h old → target', () => {
  assert.equal(isWatchdogTarget(baseTarget(), NOW_MS), true);
  assert.equal(selectWatchdogTargets([baseTarget()], { now: NOW }).length, 1);
});

// ── paid excluded (mandatory — paid deals KEEP Status='Awaiting Payment') ───

test('Deposit Paid At set → excluded (money already collected)', () => {
  const r = baseTarget({ 'Deposit Paid At': hoursAgo(1) });
  assert.equal(watchdogSkipReason(r, NOW_MS), 'already-paid');
  assert.equal(selectWatchdogTargets([r], { now: NOW }).length, 0);
});

// ── invited excluded (sent-but-unpaid belongs to deposit-request-nudge) ─────

test('Deposit Invite Sent At set → excluded (nudge rail owns it)', () => {
  const r = baseTarget({ 'Deposit Invite Sent At': hoursAgo(3) });
  assert.equal(watchdogSkipReason(r, NOW_MS), 'invite-sent');
});

// ── status gate ─────────────────────────────────────────────────────────────

test('non-Awaiting-Payment status → excluded', () => {
  const r = baseTarget({ Status: 'Closed Won' });
  assert.equal(watchdogSkipReason(r, NOW_MS), 'wrong-status');
});

test('single-select object status {name} is unwrapped', () => {
  const r = baseTarget({ Status: { name: 'Awaiting Payment' } });
  assert.equal(isWatchdogTarget(r, NOW_MS), true);
});

// ── age boundary ────────────────────────────────────────────────────────────

test('young request (1h) → excluded as too-young', () => {
  const r = baseTarget({ 'Deposit Requested At': hoursAgo(1) });
  assert.equal(watchdogSkipReason(r, NOW_MS), 'too-young');
});

test('exactly at the 2h boundary → still too-young (strict >2h)', () => {
  const r = baseTarget({
    'Deposit Requested At': new Date(NOW_MS - WATCHDOG_MIN_AGE_MS).toISOString(),
  });
  // age === MIN_AGE fails the (now - anchor < MIN_AGE) exclusion by 0ms —
  // it is eligible; one ms younger is not.
  assert.equal(isWatchdogTarget(r, NOW_MS), true);
  const younger = baseTarget({
    'Deposit Requested At': new Date(NOW_MS - WATCHDOG_MIN_AGE_MS + 1).toISOString(),
  });
  assert.equal(watchdogSkipReason(younger, NOW_MS), 'too-young');
});

// ── anchor fallback ─────────────────────────────────────────────────────────




test('neither anchor parseable → excluded (never alert on unknown age)', () => {
  const r = baseTarget({ 'Deposit Requested At': 'garbage', _createdTime: '' });
  assert.equal(watchdogSkipReason(r, NOW_MS), 'no-parseable-anchor');
  const r2 = baseTarget({ 'Deposit Requested At': '', _createdTime: undefined });
  assert.equal(watchdogSkipReason(r2, NOW_MS), 'no-parseable-anchor');
});

// ── cooldown ────────────────────────────────────────────────────────────────

test('alerted 2h ago → cooldown (no re-alert inside 24h)', () => {
  const r = baseTarget({ 'Deposit Watchdog Alerted At': hoursAgo(2) });
  assert.equal(watchdogSkipReason(r, NOW_MS), 'cooldown');
});

test('alerted 25h ago → eligible again (still stuck a day later)', () => {
  const r = baseTarget({ 'Deposit Watchdog Alerted At': hoursAgo(25) });
  assert.equal(isWatchdogTarget(r, NOW_MS), true);
});

test('corrupt alert stamp counts as RECENT → cooldown, never alert-storm', () => {
  const r = baseTarget({ 'Deposit Watchdog Alerted At': 'corrupt-stamp' });
  assert.equal(watchdogSkipReason(r, NOW_MS), 'cooldown');
});

test('cooldown boundary: exactly 24h ago is eligible', () => {
  const r = baseTarget({
    'Deposit Watchdog Alerted At': new Date(NOW_MS - WATCHDOG_COOLDOWN_MS).toISOString(),
  });
  assert.equal(isWatchdogTarget(r, NOW_MS), true);
});

// ── ordering + robustness ───────────────────────────────────────────────────

test('targets sorted oldest anchor first', () => {
  const older = baseTarget({ id: 'older', 'Deposit Requested At': hoursAgo(30) });
  const newer = baseTarget({ id: 'newer', 'Deposit Requested At': hoursAgo(5) });
  const out = selectWatchdogTargets([newer, older], { now: NOW });
  assert.deepEqual(out.map((r: any) => r.id), ['older', 'newer']);
});

test('empty / non-array input → []', () => {
  assert.deepEqual(selectWatchdogTargets([], { now: NOW }), []);
  assert.deepEqual(selectWatchdogTargets(undefined as any, { now: NOW }), []);
});

test('NOT on the deposit rail (no Deposit Requested At) → never a target', () => {
  // Legacy deals + desk stage-advances sit in Awaiting Payment with no
  // deposit flow — the 6 first-run false alarms (GTM audit 2026-07-21).
  const r = { Status: 'Awaiting Payment', _createdTime: new Date(NOW_MS - 10 * 60 * 60 * 1000).toISOString() };
  assert.equal(watchdogSkipReason(r as any, NOW_MS), 'no-parseable-anchor');
});

test('unparseable Deposit Requested At → not eligible (no createdTime fallback)', () => {
  const r = { Status: 'Awaiting Payment', 'Deposit Requested At': 'not-a-date', _createdTime: new Date(NOW_MS - 10 * 60 * 60 * 1000).toISOString() };
  assert.equal(watchdogSkipReason(r as any, NOW_MS), 'no-parseable-anchor');
});
