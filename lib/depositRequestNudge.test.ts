// lib/depositRequestNudge.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/depositRequestNudge.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDepositNudgeEligible,
  selectDepositNudges,
  DEPOSIT_NUDGE_LIFETIME_CAP,
  depositAbandonPlan,
  isDepositAbandonEligible,
  selectDepositAbandonNudges,
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

// ── RAIL B — deposit-abandon on the P5′ tiered window ───────────────────────
// Policy (lib/intentWindows 'deposit-invite'): 14d window, up to 5 touches at
// days 1/3/6/9/13 after the invite, ONE decay touch in days 14-21, then done.
// Stamps unchanged: 'Deposit Nudge Count' + 'Deposit Nudge Last Sent At'.

const DAY = 24 * HOUR;
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

function abandonRef(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 'recABN0001',
    Status: 'Intro Sent',
    ['Deposit Invite Sent At']: daysAgo(2),
    ...overrides,
  };
}

test('abandon: structural guards — not a rail-B row → plan null', () => {
  // Rancher request set → rail A's row, never rail B's.
  assert.equal(depositAbandonPlan(abandonRef({ ['Deposit Requested At']: daysAgo(1) }), NOW), null);
  // No invite stamp at all.
  assert.equal(depositAbandonPlan(abandonRef({ ['Deposit Invite Sent At']: '' }), NOW), null);
  // Paid or terminal → stop.
  assert.equal(depositAbandonPlan(abandonRef({ ['Deposit Paid At']: daysAgo(1) }), NOW), null);
  assert.equal(depositAbandonPlan(abandonRef({ Status: 'Slot Locked' }), NOW), null);
  assert.equal(depositAbandonPlan(abandonRef({ Status: { name: 'Closed Won' } }), NOW), null);
  // Corrupt last-sent stamp → fail closed, never storm.
  assert.equal(
    depositAbandonPlan(abandonRef({ ['Deposit Nudge Count']: 1, ['Deposit Nudge Last Sent At']: 'garbage' }), NOW),
    null,
  );
});

test('abandon: invite younger than 1 day → not due (invite email gets its shot)', () => {
  assert.equal(isDepositAbandonEligible(abandonRef({ ['Deposit Invite Sent At']: hoursAgo(12) }), NOW), false);
});

test('abandon: ramp — touch due at days 1/3/6/9/13, held inside each gap', () => {
  // Touch 1 at day 1+.
  assert.equal(isDepositAbandonEligible(abandonRef({ ['Deposit Invite Sent At']: daysAgo(1.5) }), NOW), true);
  // Touch 2: invite 4d ago, touch 1 fired 3d ago (day 1) → day-3 offset passed.
  assert.equal(
    isDepositAbandonEligible(
      abandonRef({ ['Deposit Invite Sent At']: daysAgo(4), ['Deposit Nudge Count']: 1, ['Deposit Nudge Last Sent At']: daysAgo(3) }),
      NOW,
    ),
    true,
  );
  // Same row inside the gap (touch 1 only 1d ago) → held.
  assert.equal(
    isDepositAbandonEligible(
      abandonRef({ ['Deposit Invite Sent At']: daysAgo(4), ['Deposit Nudge Count']: 1, ['Deposit Nudge Last Sent At']: daysAgo(1) }),
      NOW,
    ),
    false,
  );
  // Touch 5 at day 13.
  assert.equal(
    isDepositAbandonEligible(
      abandonRef({ ['Deposit Invite Sent At']: daysAgo(13.5), ['Deposit Nudge Count']: 4, ['Deposit Nudge Last Sent At']: daysAgo(4.4) }),
      NOW,
    ),
    true,
  );
});

test('abandon: OLD flat cap-2 is gone — touch 3+ now fires inside the window', () => {
  const r = abandonRef({
    ['Deposit Invite Sent At']: daysAgo(7),
    ['Deposit Nudge Count']: 2,
    ['Deposit Nudge Last Sent At']: daysAgo(3.5),
  });
  const plan = depositAbandonPlan(r, NOW);
  assert.deepEqual(plan, { due: true, exhausted: false, tier: 'sprint' });
});

test('abandon: decay — ONE final touch in days 14-21, then exhausted forever', () => {
  const decayDue = abandonRef({
    ['Deposit Invite Sent At']: daysAgo(16),
    ['Deposit Nudge Count']: 5,
    ['Deposit Nudge Last Sent At']: daysAgo(3),
  });
  assert.deepEqual(depositAbandonPlan(decayDue, NOW), { due: true, exhausted: false, tier: 'decay' });

  // Decay touch already sent (last touch after the day-14 boundary) → done.
  const decaySpent = abandonRef({
    ['Deposit Invite Sent At']: daysAgo(18),
    ['Deposit Nudge Count']: 6,
    ['Deposit Nudge Last Sent At']: daysAgo(2),
  });
  const p = depositAbandonPlan(decaySpent, NOW);
  assert.equal(p?.due, false);
  assert.equal(p?.exhausted, true);

  // Past day 21 entirely → done, never late-fire.
  const dead = abandonRef({
    ['Deposit Invite Sent At']: daysAgo(30),
    ['Deposit Nudge Count']: 3,
    ['Deposit Nudge Last Sent At']: daysAgo(18),
  });
  assert.deepEqual(depositAbandonPlan(dead, NOW), { due: false, exhausted: true, tier: 'done' });
});

test('abandon selector: oldest invite first, cap respected, ineligible dropped', () => {
  const rows = [
    abandonRef({ id: 'recBNEW', ['Deposit Invite Sent At']: daysAgo(1.2) }),
    abandonRef({ id: 'recBOLD', ['Deposit Invite Sent At']: daysAgo(10), ['Deposit Nudge Count']: 2, ['Deposit Nudge Last Sent At']: daysAgo(4.5) }),
    abandonRef({ id: 'recBPAID', ['Deposit Paid At']: hoursAgo(1) }),
    abandonRef({ id: 'recBHELD', ['Deposit Invite Sent At']: daysAgo(2), ['Deposit Nudge Count']: 1, ['Deposit Nudge Last Sent At']: hoursAgo(10) }),
  ];
  const picked = selectDepositAbandonNudges(rows, { nowMs: NOW, batchCap: 5 });
  assert.deepEqual(picked.map((r) => r.id), ['recBOLD', 'recBNEW']);
});
