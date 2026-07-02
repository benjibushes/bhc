import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// lib/referralLock.ts is pure + zero-import — safe under `tsx --test`.
import {
  LOCKED_STATUSES,
  isReferralLocked,
  isDepositLocked,
  DEPOSIT_LOCKED_MESSAGE,
} from './referralLock';

// ── Blocker 3 (2026-07-01): 'Slot Locked' joins the working-lead lock ────────
// 'Slot Locked' means the deposit is PAID and the slot is held. It was missing
// from LOCKED_STATUSES, so auto-paths (chasup auto-close, stuck-buyer
// recovery, email-sequences MATCH_NOW, admin reassign without override) could
// still move a paid deal — and quick-action pass on it fell through the lock.

test('LOCKED_STATUSES is exactly the four working-lead statuses incl. Slot Locked', () => {
  assert.deepEqual(
    [...LOCKED_STATUSES].sort(),
    ['Awaiting Payment', 'Negotiation', 'Rancher Contacted', 'Slot Locked'],
  );
});

test('Slot Locked referrals are locked against every auto-path', () => {
  assert.equal(isReferralLocked('Slot Locked'), true);
  assert.equal(isReferralLocked({ Status: 'Slot Locked' }), true);
});

test('pre-engagement + terminal statuses stay unlocked (no scope creep)', () => {
  for (const s of ['Intro Sent', 'Pending Approval', 'Closed Won', 'Closed Lost', 'Refunded', '']) {
    assert.equal(isReferralLocked(s), false, `${s} must stay unlocked`);
  }
  assert.equal(isReferralLocked(null), false);
  assert.equal(isReferralLocked(undefined), false);
});

// ── Money lock: Deposit Paid At stamped ⇒ one-click email links refuse ───────
// A 30-day-old Pass link (or a corporate mail scanner prefetching it) on a
// deposit-paid deal closed it Lost, freed the slot, and re-routed the paying
// buyer toward a SECOND deposit. Money in = quick-action links may only ever
// hand off to the dashboard's explicit flows.

test('isDepositLocked: a settlement stamp locks; empty/missing stays open', () => {
  assert.equal(isDepositLocked('2026-06-20T09:30:00.000Z'), true);
  for (const v of [null, undefined, '', '   ']) {
    assert.equal(isDepositLocked(v), false, `${JSON.stringify(v)} must not lock`);
  }
});

test('DEPOSIT_LOCKED_MESSAGE is friendly and points the rancher at the dashboard', () => {
  assert.match(DEPOSIT_LOCKED_MESSAGE, /dashboard/i);
  assert.doesNotMatch(DEPOSIT_LOCKED_MESSAGE, /error|invalid|forbidden/i);
});

// ── Route-shape pins ──────────────────────────────────────────────────────────
// Next.js App Router route files may only export HTTP handlers + segment
// config, so quick-action's TERMINAL_STATUSES can't be imported here. Pin the
// source shape instead so a silent revert shows up as a test failure.
const routeSrc = readFileSync(
  fileURLToPath(new URL('../app/api/rancher/quick-action/route.ts', import.meta.url)),
  'utf8',
);

test('quick-action TERMINAL_STATUSES includes Slot Locked (route-shape pin)', () => {
  const m = routeSrc.match(/const TERMINAL_STATUSES = \[([^\]]*)\]/);
  assert.ok(m, 'TERMINAL_STATUSES array literal must exist in quick-action route');
  assert.match(m![1], /'Slot Locked'/, "'Slot Locked' must be terminal for one-click links");
  assert.match(m![1], /'Awaiting Payment'/, 'audit #15 entry must survive');
});

test('quick-action gates every mutation behind the money lock (route-shape pin)', () => {
  assert.match(routeSrc, /isDepositLocked/, 'route must consult the deposit lock');
  assert.match(routeSrc, /DEPOSIT_LOCKED_MESSAGE/, 'route must render the shared friendly refusal');
});
