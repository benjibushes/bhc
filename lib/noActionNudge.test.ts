// qualified-no-action selector — red-first tests (2026-07-02).
//
// THE BUG THIS PINS: the cron's old Airtable formula (on Consumers) excluded
// {Buyer Stage}='MATCHED', while its per-buyer loop required a Referral with
// Status='Intro Sent'. Matching sets BOTH together (matching/suggest sets
// Referral Status='Intro Sent' AND Buyer Stage='MATCHED' in the same pass) —
// so the formula pre-excluded everyone the loop could nudge. Hourly cron,
// selected ~0 rows, nudged nobody, forever. The selection now lives in this
// pure, unit-tested module (the inline formula burned once already — the
// original CONV-4 formula referenced a field that doesn't exist on Consumers
// and errored every 30min until "fixed" into the select-nothing shape).
//
// New shape (Referrals-first): select Referrals with Status='Intro Sent' AND
// no Deposit Paid At, whose Intro Sent At is 30min–4h old, then join to the
// Consumer for the suppression trio + dedup stamp + email.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nudge from './noActionNudge';

const {
  NUDGE_WINDOW_MIN_MS,
  NUDGE_WINDOW_MAX_MS,
  isNudgeEligibleReferral,
  isNudgeEligibleConsumer,
  buildNudgeReferralFormula,
} = nudge as any;

const NOW = new Date('2026-07-02T18:00:00.000Z').getTime();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function refFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'Status': 'Intro Sent',
    'Intro Sent At': new Date(NOW - 1 * HOUR).toISOString(),
    'Deposit Paid At': undefined,
    ...overrides,
  };
}

function consumerFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'Email': 'buyer@example.com',
    'Unsubscribed': false,
    'Bounced': false,
    'Complained': false,
    'Notes': 'quiz score 9/10',
    ...overrides,
  };
}

test('module exports the pure selector pieces', () => {
  assert.equal(typeof isNudgeEligibleReferral, 'function');
  assert.equal(typeof isNudgeEligibleConsumer, 'function');
  assert.equal(typeof buildNudgeReferralFormula, 'function');
  assert.equal(NUDGE_WINDOW_MIN_MS, 30 * MIN, 'first-nudge sweet spot starts at 30min');
  assert.equal(NUDGE_WINDOW_MAX_MS, 4 * HOUR, 'nudge window closes at 4h');
});

// ── referral predicate ──────────────────────────────────────────────────────

test('Intro Sent + no deposit + intro 1h ago → eligible (the row the old selector could never return)', () => {
  assert.equal(isNudgeEligibleReferral(refFields(), NOW), true);
});

test('deposit already paid → not eligible (they acted)', () => {
  assert.equal(
    isNudgeEligibleReferral(refFields({ 'Deposit Paid At': new Date(NOW - 10 * MIN).toISOString() }), NOW),
    false,
  );
});

test('non-Intro-Sent statuses → not eligible', () => {
  for (const status of ['Pending Approval', 'Awaiting Payment', 'Slot Locked', 'Closed Won', 'Closed Lost', '']) {
    assert.equal(
      isNudgeEligibleReferral(refFields({ 'Status': status }), NOW),
      false,
      `status '${status}' must not be nudged`,
    );
  }
});

test('intro sent 10min ago → too fresh (nudging inside 30min is pushy)', () => {
  assert.equal(
    isNudgeEligibleReferral(refFields({ 'Intro Sent At': new Date(NOW - 10 * MIN).toISOString() }), NOW),
    false,
  );
});

test('intro sent 5h ago → window closed (forgotten; belongs to later lifecycle crons)', () => {
  assert.equal(
    isNudgeEligibleReferral(refFields({ 'Intro Sent At': new Date(NOW - 5 * HOUR).toISOString() }), NOW),
    false,
  );
});

test('missing or unparseable Intro Sent At → not eligible (never guess a window)', () => {
  assert.equal(isNudgeEligibleReferral(refFields({ 'Intro Sent At': undefined }), NOW), false);
  assert.equal(isNudgeEligibleReferral(refFields({ 'Intro Sent At': '' }), NOW), false);
  assert.equal(isNudgeEligibleReferral(refFields({ 'Intro Sent At': 'not-a-date' }), NOW), false);
});

// ── consumer predicate (suppression trio + dedup stamp + email) ─────────────

test('clean consumer → eligible', () => {
  assert.equal(isNudgeEligibleConsumer(consumerFields()), true);
});

test('suppression trio each blocks the nudge', () => {
  assert.equal(isNudgeEligibleConsumer(consumerFields({ 'Unsubscribed': true })), false);
  assert.equal(isNudgeEligibleConsumer(consumerFields({ 'Bounced': true })), false);
  assert.equal(isNudgeEligibleConsumer(consumerFields({ 'Complained': true })), false);
});

test('existing [no-action-nudge stamp blocks a re-nudge (claim-before-send dedup)', () => {
  assert.equal(
    isNudgeEligibleConsumer(consumerFields({ 'Notes': '[no-action-nudge 2026-07-01] quiz score 9/10' })),
    false,
  );
});

test('missing email blocks the nudge', () => {
  assert.equal(isNudgeEligibleConsumer(consumerFields({ 'Email': '' })), false);
  assert.equal(isNudgeEligibleConsumer(consumerFields({ 'Email': '   ' })), false);
});

// ── formula builder (mirrors the predicate; keeps Airtable I/O bounded) ─────

test('referral formula selects Intro Sent + blank deposit + Intro Sent At window', () => {
  const start = new Date(NOW - NUDGE_WINDOW_MAX_MS).toISOString();
  const end = new Date(NOW - NUDGE_WINDOW_MIN_MS).toISOString();
  const formula: string = buildNudgeReferralFormula(start, end);
  assert.match(formula, /\{Status\}\s*=\s*'Intro Sent'/);
  assert.match(formula, /\{Deposit Paid At\}\s*=\s*BLANK\(\)/);
  assert.ok(formula.includes(`IS_AFTER({Intro Sent At}, '${start}')`), 'window start must anchor on Intro Sent At');
  assert.ok(formula.includes(`IS_BEFORE({Intro Sent At}, '${end}')`), 'window end must anchor on Intro Sent At');
  // The bug class this file exists to kill: the selector must NOT touch
  // Buyer Stage — that field lives on Consumers and its old exclusions are
  // exactly what made the cron select nothing.
  assert.ok(!formula.includes('Buyer Stage'), 'selector must be Referrals-native');
  assert.ok(!formula.includes('Qualified At'), 'window anchors on Intro Sent At, not Qualified At');
});
