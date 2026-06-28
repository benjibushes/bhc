import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDepositIntent,
  isRecoveryEmailEligible,
  isRecoverySmsEligible,
  nextRecoveryStep,
  selectRecoveryEmail,
  selectRecoverySms,
  reserveCreatedMs,
  hoursSinceReserve,
  renderRecoveryEmail,
  renderRecoverySms,
  DEFAULT_RESERVE_RECOVERY_HOURS,
  DEFAULT_RESERVE_RECOVERY_SMS_HOURS,
  RECOVERY_EXCLUDED_STATUSES,
  type RecoveryReferralLike,
} from './reserveRecovery';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-06-27T12:00:00Z');
const hoursAgo = (n: number) => new Date(NOW - n * HOUR).toISOString();

// A live abandoned reserve: deposit-intent Match Type, no Deposit Paid At,
// Pending status, created > 3h ago, not recovered.
const liveReserve = (over: Partial<RecoveryReferralLike> = {}): RecoveryReferralLike => ({
  id: 'recRES',
  Status: 'Pending',
  'Match Type': 'Direct (Rancher Page) — Deposit',
  'Deposit Paid At': '',
  _createdTime: hoursAgo(DEFAULT_RESERVE_RECOVERY_HOURS + 1),
  ...over,
});

// ─── deposit-intent identification ───────────────────────────────────────────

test('isDepositIntent: only deposit Match Types', () => {
  assert.equal(isDepositIntent({ 'Match Type': 'Direct (Rancher Page) — Deposit' }), true);
  assert.equal(isDepositIntent({ 'Match Type': 'Direct (Rancher Page) — Deposit (1-tap)' }), true);
  assert.equal(isDepositIntent({ 'Match Type': 'AI Match' }), false);
  assert.equal(isDepositIntent({ 'Match Type': '' }), false);
  assert.equal(isDepositIntent({}), false);
});

// ─── STEP 1: recovery EMAIL eligibility ──────────────────────────────────────

test('email eligible: live abandoned reserve, > N hours old, not recovered', () => {
  assert.equal(isRecoveryEmailEligible(liveReserve(), { now: NOW }), true);
});

test('email NOT eligible: deposit already paid (not abandoned)', () => {
  assert.equal(isRecoveryEmailEligible(liveReserve({ 'Deposit Paid At': hoursAgo(1) }), { now: NOW }), false);
});

test('email NOT eligible: not a deposit-intent referral', () => {
  assert.equal(isRecoveryEmailEligible(liveReserve({ 'Match Type': 'AI Match' }), { now: NOW }), false);
});

test('email NOT eligible: too fresh (< 3h since reserve)', () => {
  assert.equal(isRecoveryEmailEligible(liveReserve({ _createdTime: hoursAgo(1) }), { now: NOW }), false);
});

test('email NOT eligible: already recovered (Reserve Recovery Sent At set) — idempotent', () => {
  assert.equal(
    isRecoveryEmailEligible(liveReserve({ 'Reserve Recovery Sent At': hoursAgo(1) }), { now: NOW }),
    false,
  );
});

test('email NOT eligible: no creation time → cannot age → skip (safe)', () => {
  assert.equal(isRecoveryEmailEligible(liveReserve({ _createdTime: '' }), { now: NOW }), false);
});

// ── EXCLUSION: terminal / past-reserve statuses ─────────────────────────────

test('email NOT eligible: every excluded status (Awaiting Payment / Slot Locked / Closed Won / Closed Lost / Refunded / Cancelled / Expired)', () => {
  for (const status of RECOVERY_EXCLUDED_STATUSES) {
    assert.equal(
      isRecoveryEmailEligible(liveReserve({ Status: status }), { now: NOW }),
      false,
      `status ${status} must be excluded`,
    );
  }
});

test('email eligible: blank status (a bare Pending-less reserve) still recovers', () => {
  assert.equal(isRecoveryEmailEligible(liveReserve({ Status: '' }), { now: NOW }), true);
});

// ── EXCLUSION: refunded / disputed (Referral OR linked Payments row) ─────────

test('email NOT eligible: Referral-side Refunded At', () => {
  assert.equal(isRecoveryEmailEligible(liveReserve({ 'Refunded At': hoursAgo(1) }), { now: NOW }), false);
});

test('email NOT eligible: Referral-side Dispute Status', () => {
  assert.equal(isRecoveryEmailEligible(liveReserve({ 'Dispute Status': 'needs_response' }), { now: NOW }), false);
});

test('email NOT eligible: linked Payments row refunded (authoritative)', () => {
  assert.equal(
    isRecoveryEmailEligible(liveReserve({ __payment: { 'Refunded At': hoursAgo(2) } }), { now: NOW }),
    false,
  );
  assert.equal(
    isRecoveryEmailEligible(liveReserve({ __payment: { Status: 'refunded' } }), { now: NOW }),
    false,
  );
  assert.equal(
    isRecoveryEmailEligible(liveReserve({ __payment: { 'Dispute Status': 'warning_needs_response' } }), { now: NOW }),
    false,
  );
});

test('email eligible: a non-refunded linked Payments row does NOT exclude', () => {
  assert.equal(
    isRecoveryEmailEligible(liveReserve({ __payment: { Status: 'succeeded' } }), { now: NOW }),
    true,
  );
});

// ─── STEP 2: recovery SMS eligibility ────────────────────────────────────────

const emailedReserve = (over: Partial<RecoveryReferralLike> = {}): RecoveryReferralLike =>
  liveReserve({
    'Reserve Recovery Sent At': hoursAgo(DEFAULT_RESERVE_RECOVERY_SMS_HOURS + 1),
    ...over,
  });

test('sms eligible: email already sent > smsHours ago, still abandoned, sms not yet sent', () => {
  assert.equal(isRecoverySmsEligible(emailedReserve(), { now: NOW }), true);
});

test('sms NOT eligible: recovery email never sent (SMS only follows an email)', () => {
  assert.equal(
    isRecoverySmsEligible(liveReserve({ 'Reserve Recovery Sent At': '' }), { now: NOW }),
    false,
  );
});

test('sms NOT eligible: not enough time since the email', () => {
  assert.equal(
    isRecoverySmsEligible(emailedReserve({ 'Reserve Recovery Sent At': hoursAgo(2) }), { now: NOW }),
    false,
  );
});

test('sms NOT eligible: SMS already sent (idempotent)', () => {
  assert.equal(
    isRecoverySmsEligible(emailedReserve({ 'Reserve Recovery SMS Sent At': hoursAgo(1) }), { now: NOW }),
    false,
  );
});

test('sms NOT eligible: deposit got paid after the email (converted)', () => {
  assert.equal(
    isRecoverySmsEligible(emailedReserve({ 'Deposit Paid At': hoursAgo(1) }), { now: NOW }),
    false,
  );
});

test('sms NOT eligible: refunded after the email', () => {
  assert.equal(
    isRecoverySmsEligible(emailedReserve({ __payment: { 'Refunded At': hoursAgo(1) } }), { now: NOW }),
    false,
  );
});

test('sms NOT eligible: terminal status after the email', () => {
  assert.equal(isRecoverySmsEligible(emailedReserve({ Status: 'Closed Lost' }), { now: NOW }), false);
});

test('recovery timing honors custom windows', () => {
  // created 2h ago: not eligible at default 3h, eligible at a 1h override.
  const r = liveReserve({ _createdTime: hoursAgo(2) });
  assert.equal(isRecoveryEmailEligible(r, { now: NOW }), false);
  assert.equal(isRecoveryEmailEligible(r, { now: NOW, recoveryHours: 1 }), true);
});

// ─── next-step precedence + selectors ────────────────────────────────────────

test('nextRecoveryStep: email takes precedence, then sms, then null', () => {
  assert.equal(nextRecoveryStep(liveReserve(), { now: NOW }), 'email');
  assert.equal(nextRecoveryStep(emailedReserve(), { now: NOW }), 'sms');
  // fully recovered → null
  assert.equal(
    nextRecoveryStep(
      emailedReserve({ 'Reserve Recovery SMS Sent At': hoursAgo(1) }),
      { now: NOW },
    ),
    null,
  );
  // paid → null
  assert.equal(nextRecoveryStep(liveReserve({ 'Deposit Paid At': hoursAgo(1) }), { now: NOW }), null);
});

test('selectRecoveryEmail / selectRecoverySms filter a mixed list', () => {
  const rows: RecoveryReferralLike[] = [
    liveReserve({ id: 'a' }), // email
    emailedReserve({ id: 'b' }), // sms
    liveReserve({ id: 'c', 'Deposit Paid At': hoursAgo(1) }), // neither (paid)
    liveReserve({ id: 'd', Status: 'Closed Won' }), // neither (terminal)
    liveReserve({ id: 'e', __payment: { Status: 'refunded' } }), // neither (refunded)
  ];
  assert.deepEqual(selectRecoveryEmail(rows, { now: NOW }).map((r) => r.id), ['a']);
  assert.deepEqual(selectRecoverySms(rows, { now: NOW }).map((r) => r.id), ['b']);
});

test('selectors handle empty/garbage input', () => {
  assert.deepEqual(selectRecoveryEmail([], { now: NOW }), []);
  assert.deepEqual(selectRecoverySms(undefined as any, { now: NOW }), []);
});

// ─── helpers ─────────────────────────────────────────────────────────────────

test('reserveCreatedMs / hoursSinceReserve read _createdTime', () => {
  assert.equal(reserveCreatedMs(liveReserve({ _createdTime: hoursAgo(5) })), NOW - 5 * HOUR);
  assert.equal(hoursSinceReserve(liveReserve({ _createdTime: hoursAgo(5) }), NOW), 5);
  assert.equal(reserveCreatedMs({ _createdTime: '' }), 0);
  assert.equal(hoursSinceReserve({ _createdTime: '' }, NOW), 0);
});

// ─── copy: email + SMS ───────────────────────────────────────────────────────

const ctx = {
  firstName: 'Sam',
  cut: 'quarter',
  rancher: 'Foodstead',
  link: 'https://buyhalfcow.com/r/d/tok',
};

test('renderRecoveryEmail: held-share angle, cut + rancher + link, html anchor', () => {
  const m = renderRecoveryEmail({ ...ctx });
  assert.match(m.subject, /your quarter share is still held, Sam/);
  assert.match(m.text, /you started reserving a quarter share from Foodstead/);
  assert.match(m.text, /we held your spot/);
  assert.match(m.text, /buyhalfcow\.com\/r\/d\/tok/);
  assert.match(m.html, /<a href="https:\/\/buyhalfcow\.com\/r\/d\/tok"/);
});

test('renderRecoveryEmail: social proof injected / omitted cleanly', () => {
  const shown = renderRecoveryEmail({ ...ctx, socialProof: '6 families reserved their share this week.' });
  assert.match(shown.text, /6 families reserved their share this week\./);
  const omitted = renderRecoveryEmail({ ...ctx, socialProof: '' });
  assert.doesNotMatch(omitted.text, /\{socialProof\}/);
  assert.doesNotMatch(omitted.text, /\n\n\n/, 'no empty paragraph on omit');
});

test('renderRecoverySms: DISTINCT angle (hold releasing), carries STOP', () => {
  const sms = renderRecoverySms({ ...ctx });
  assert.match(sms, /hold releases soon/, 'different angle than the email (held vs releasing)');
  assert.match(sms, /reply STOP to opt out/);
  assert.match(sms, /Foodstead/);
  assert.match(sms, /quarter share/);
  assert.match(sms, /buyhalfcow\.com\/r\/d\/tok/);
});

test('recovery SMS angle differs from the recovery EMAIL (ADD new info, not a repeat)', () => {
  const sms = renderRecoverySms({ ...ctx });
  const email = renderRecoveryEmail({ ...ctx }).text;
  assert.notEqual(sms.trim(), email.trim());
  // The email leads with "we held your spot"; the SMS leads with urgency.
  assert.doesNotMatch(sms, /we held your spot/);
});

// A2 — recovery email social proof must NOT glue to the next sentence.
test('A2 recovery email with proof: no glue into "it\'s still here"', () => {
  const m = renderRecoveryEmail({ ...ctx, socialProof: '6 families reserved their share this week.' });
  assert.doesNotMatch(m.text, /this week\.it's still here/, 'no glued sentence');
  assert.match(m.text, /this week\.\n\nit's still here/, 'proof on its own paragraph');
  assert.doesNotMatch(m.text, /\{socialProof\}/);
});

test('A2 recovery email omit: clean collapse, no empty paragraph, no glue', () => {
  const m = renderRecoveryEmail({ ...ctx, socialProof: '' });
  assert.doesNotMatch(m.text, /\{socialProof\}/);
  assert.doesNotMatch(m.text, /\n{3,}/, 'no empty paragraph');
  // The sentence before the (omitted) proof flows straight into the CTA line.
  assert.match(m.text, /we held your spot\.\n\nit's still here/);
});
