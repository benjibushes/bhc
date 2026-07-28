// lib/depositSmsRescue.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/depositSmsRescue.test.ts
//
// SMS RESCUE LEG + DESK NEVER-OPENED LIST (2026-07-28 conversion audit).
// The 48h/no-open selector and the never-opened desk selector are pure —
// pinned here without Airtable. No SMS fires in any test (selection only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDepositSmsRescueEligible,
  selectDepositSmsRescues,
  renderDepositSmsNudge,
  isDepositNeverOpened,
  selectDepositNeverOpened,
  durableDepositPayLink,
  DEPOSIT_SMS_SENT_FIELD,
  DEPOSIT_SMS_NO_OPEN_WINDOW_MS,
  DEPOSIT_NEVER_OPENED_MIN_AGE_MS,
} from './depositRequestNudge';

const NOW = Date.parse('2026-07-28T18:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(NOW - h * HOUR).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

// A rail-A row that already got its first email nudge 50h ago and never
// opened the deposit page — the SMS-eligible baseline.
function ref(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 'recSMS0001',
    Status: 'Awaiting Payment',
    ['Deposit Requested At']: daysAgo(4),
    ['Deposit Nudge Count']: 1,
    ['Deposit Nudge Last Sent At']: hoursAgo(50),
    ...overrides,
  };
}

// ── SMS rescue predicate ─────────────────────────────────────────────────────

test('eligible: first email nudge 48h+ ago, never opened, unpaid, no SMS yet', () => {
  assert.equal(isDepositSmsRescueEligible(ref(), NOW), true);
});

test('window constant is 48h', () => {
  assert.equal(DEPOSIT_SMS_NO_OPEN_WINDOW_MS, 48 * HOUR);
});

test('NOT eligible before the FIRST email nudge (count 0) — SMS never leads', () => {
  assert.equal(
    isDepositSmsRescueEligible(ref({ ['Deposit Nudge Count']: 0 }), NOW),
    false,
  );
  assert.equal(
    isDepositSmsRescueEligible(ref({ ['Deposit Nudge Count']: undefined }), NOW),
    false,
  );
});

test('NOT eligible inside the 48h no-open window', () => {
  assert.equal(
    isDepositSmsRescueEligible(ref({ ['Deposit Nudge Last Sent At']: hoursAgo(47) }), NOW),
    false,
  );
  // Exactly at the boundary counts as elapsed.
  assert.equal(
    isDepositSmsRescueEligible(ref({ ['Deposit Nudge Last Sent At']: hoursAgo(48) }), NOW),
    true,
  );
});

test('NOT eligible when the buyer OPENED the deposit page (email worked — no SMS)', () => {
  assert.equal(
    isDepositSmsRescueEligible(ref({ ['Deposit Link Opened At']: hoursAgo(2) }), NOW),
    false,
  );
});

test('IDEMPOTENT: one SMS per referral, ever — stamp blocks forever', () => {
  assert.equal(
    isDepositSmsRescueEligible(ref({ [DEPOSIT_SMS_SENT_FIELD]: daysAgo(30) }), NOW),
    false,
  );
});

test('NOT eligible: paid, off-status, or not a rancher-sent request', () => {
  assert.equal(isDepositSmsRescueEligible(ref({ ['Deposit Paid At']: hoursAgo(1) }), NOW), false);
  assert.equal(isDepositSmsRescueEligible(ref({ Status: 'Closed Lost' }), NOW), false);
  assert.equal(isDepositSmsRescueEligible(ref({ Status: { name: 'Slot Locked' } }), NOW), false);
  assert.equal(isDepositSmsRescueEligible(ref({ ['Deposit Requested At']: '' }), NOW), false);
});

test('fails CLOSED on corrupt or missing nudge anchor (no storm, no blind SMS)', () => {
  assert.equal(
    isDepositSmsRescueEligible(ref({ ['Deposit Nudge Last Sent At']: 'not-a-date' }), NOW),
    false,
  );
  // count>=1 but no last-sent stamp = data drift — no anchor, no SMS.
  assert.equal(
    isDepositSmsRescueEligible(ref({ ['Deposit Nudge Last Sent At']: '' }), NOW),
    false,
  );
});

// ── SMS rescue selector ──────────────────────────────────────────────────────

test('selector: oldest request first, cap respected, ineligible dropped', () => {
  const rows = [
    ref({ id: 'recNEWER', ['Deposit Requested At']: daysAgo(3) }),
    ref({ id: 'recOLDEST', ['Deposit Requested At']: daysAgo(9) }),
    ref({ id: 'recOPENED', ['Deposit Link Opened At']: hoursAgo(1) }),
    ref({ id: 'recMID', ['Deposit Requested At']: daysAgo(6) }),
  ];
  const picked = selectDepositSmsRescues(rows, { nowMs: NOW, batchCap: 2 });
  assert.deepEqual(picked.map((r) => r.id), ['recOLDEST', 'recMID']);
});

test('selector: excludeIds keeps a same-run email row out (no double-touch)', () => {
  const rows = [ref({ id: 'recA' }), ref({ id: 'recB' })];
  const picked = selectDepositSmsRescues(rows, {
    nowMs: NOW,
    excludeIds: new Set(['recA']),
  });
  assert.deepEqual(picked.map((r) => r.id), ['recB']);
});

test('selector: empty/garbage input never throws', () => {
  assert.deepEqual(selectDepositSmsRescues([], { nowMs: NOW }), []);
  assert.deepEqual(selectDepositSmsRescues(null as any, { nowMs: NOW }), []);
  assert.deepEqual(selectDepositSmsRescues([ref()], { nowMs: NOW, batchCap: 0 }), []);
});

// ── SMS template ─────────────────────────────────────────────────────────────

test('SMS body: tokens filled, link present, STOP-compliant', () => {
  const body = renderDepositSmsNudge({
    firstName: 'Dana',
    rancherName: 'Foodstead',
    link: 'https://www.buyhalfcow.com/r/p/tok123',
  });
  assert.ok(body.includes('Dana'));
  assert.ok(body.includes('Foodstead'));
  assert.ok(body.includes('https://www.buyhalfcow.com/r/p/tok123'));
  assert.ok(/reply stop/i.test(body));
  assert.ok(!body.includes('{'), 'no unfilled tokens');
});

// ── desk never-opened selector ───────────────────────────────────────────────

function deskRef(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 'recDESK001',
    Status: 'Awaiting Payment',
    ['Deposit Requested At']: daysAgo(10),
    ...overrides,
  };
}

test('never-opened: requested >7d ago, unpaid, never opened → on the list', () => {
  assert.equal(isDepositNeverOpened(deskRef(), NOW), true);
  assert.equal(DEPOSIT_NEVER_OPENED_MIN_AGE_MS, 7 * 24 * HOUR);
});

test('never-opened: younger than 7d stays off (the crons still own it)', () => {
  assert.equal(isDepositNeverOpened(deskRef({ ['Deposit Requested At']: daysAgo(6) }), NOW), false);
});

test('never-opened: opened / paid / off-status / no-request all excluded', () => {
  assert.equal(isDepositNeverOpened(deskRef({ ['Deposit Link Opened At']: daysAgo(1) }), NOW), false);
  assert.equal(isDepositNeverOpened(deskRef({ ['Deposit Paid At']: daysAgo(1) }), NOW), false);
  assert.equal(isDepositNeverOpened(deskRef({ Status: 'Closed Won' }), NOW), false);
  assert.equal(isDepositNeverOpened(deskRef({ ['Deposit Requested At']: '' }), NOW), false);
});

test('never-opened selector: oldest first + limit', () => {
  const rows = [
    deskRef({ id: 'recD8', ['Deposit Requested At']: daysAgo(8) }),
    deskRef({ id: 'recD30', ['Deposit Requested At']: daysAgo(30) }),
    deskRef({ id: 'recD2', ['Deposit Requested At']: daysAgo(2) }),
    deskRef({ id: 'recD15', ['Deposit Requested At']: daysAgo(15) }),
  ];
  const picked = selectDepositNeverOpened(rows, { nowMs: NOW, limit: 2 });
  assert.deepEqual(picked.map((r) => r.id), ['recD30', 'recD15']);
});

// ── durable pay link guard ───────────────────────────────────────────────────

test('durableDepositPayLink: only durable /r/p/ links survive', () => {
  assert.equal(
    durableDepositPayLink('https://www.buyhalfcow.com/r/p/abc123'),
    'https://www.buyhalfcow.com/r/p/abc123',
  );
  // Raw Stripe checkout URLs expire in ~24h — NEVER hand one to Ben to text.
  assert.equal(durableDepositPayLink('https://checkout.stripe.com/c/pay/cs_x'), '');
  assert.equal(durableDepositPayLink(''), '');
  assert.equal(durableDepositPayLink(undefined as any), '');
});
