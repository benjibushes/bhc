import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  brokerSheetDelivery,
  depositNextSteps,
  depositRailForReferral,
} from './depositSuccessCopy';

// ── brokerSheetDelivery — did the represented ranch actually get the sheet? ──
//
// Two Notes marker formats exist and BOTH must be read: the format on main
// today ("rancher notified … sent=true|false") and the hardened one from the
// broker-notify work ("rancher fulfillment sheet … DELIVERED | NOT DELIVERED
// (outcome)"). Anything else is 'unknown' — never an optimistic 'delivered'.

test('sheet delivery: hardened marker DELIVERED', () => {
  assert.equal(
    brokerSheetDelivery({
      Notes: 'earlier ops note\n[broker] rancher fulfillment sheet 2026-08-17T10:00:00.000Z — DELIVERED',
    }),
    'delivered',
  );
});

test('sheet delivery: hardened marker NOT DELIVERED (suppressed)', () => {
  assert.equal(
    brokerSheetDelivery({
      Notes: '[broker] rancher fulfillment sheet 2026-08-17T10:00:00.000Z — NOT DELIVERED (suppressed: hard bounce)',
    }),
    'not-delivered',
  );
});

test('sheet delivery: legacy marker sent=true', () => {
  assert.equal(
    brokerSheetDelivery({
      Notes: '[broker] rancher notified 2026-08-17T10:00:00.000Z — sent=true',
    }),
    'delivered',
  );
});

test('sheet delivery: legacy marker sent=false', () => {
  assert.equal(
    brokerSheetDelivery({
      Notes: '[broker] rancher notified 2026-08-17T10:00:00.000Z — sent=false',
    }),
    'not-delivered',
  );
});

test('sheet delivery: the LAST marker wins (a resend supersedes a failure)', () => {
  assert.equal(
    brokerSheetDelivery({
      Notes:
        '[broker] rancher notified 2026-08-17T10:00:00.000Z — sent=false\n' +
        '[broker] rancher fulfillment sheet 2026-08-17T11:00:00.000Z — DELIVERED',
    }),
    'delivered',
  );
});

test('sheet delivery: no marker at all → unknown, never delivered', () => {
  assert.equal(brokerSheetDelivery({ Notes: 'just an ops note' }), 'unknown');
  assert.equal(brokerSheetDelivery({}), 'unknown');
  assert.equal(brokerSheetDelivery(null), 'unknown');
});

test('sheet delivery: Intro Sent At alone is NOT proof (main stamps it unconditionally)', () => {
  assert.equal(
    brokerSheetDelivery({ 'Intro Sent At': '2026-08-17T10:00:00.000Z' }),
    'unknown',
  );
});

// ── depositNextSteps — the "What happens next" list, per rail ────────────────

const CONNECT = depositNextSteps({ rail: 'connect', rancherLabel: 'Granite Hollow' });

test('connect steps are unchanged: notified today, thread this week, Stripe payout', () => {
  assert.equal(CONNECT.length, 3);
  assert.equal(CONNECT[0].when, 'Today:');
  assert.match(CONNECT[0].text, /We let Granite Hollow know your deposit landed\./);
  assert.match(CONNECT[1].text, /in your message thread/);
  assert.match(CONNECT[2].text, /gets paid out by Stripe/);
});

const brokerSteps = (sheetDelivery: 'delivered' | 'not-delivered' | 'unknown') =>
  depositNextSteps({ rail: 'broker', rancherLabel: 'Granite Hollow', sheetDelivery });

test('broker steps NEVER promise a message thread, a dashboard, or a Stripe payout', () => {
  for (const verdict of ['delivered', 'not-delivered', 'unknown'] as const) {
    const joined = brokerSteps(verdict).map((s) => s.text).join(' ');
    assert.doesNotMatch(joined, /message thread/i, `${verdict}: no thread on this rail`);
    assert.doesNotMatch(joined, /dashboard/i, `${verdict}: a represented ranch has no login`);
    assert.doesNotMatch(joined, /paid out by Stripe|payout/i, `${verdict}: no Connect payout`);
    assert.doesNotMatch(joined, /accepts? your slot|Accept Slot/i, `${verdict}: nothing accepts a slot here`);
  }
});

test('broker steps say the balance is paid directly to the ranch', () => {
  const joined = brokerSteps('delivered').map((s) => s.text).join(' ');
  assert.match(joined, /balance/i);
  assert.match(joined, /directly to the ranch|directly to Granite Hollow/i);
});

test('broker steps NEVER tell the buyer the deposit is BuyHalfCow revenue', () => {
  for (const verdict of ['delivered', 'not-delivered', 'unknown'] as const) {
    const joined = brokerSteps(verdict).map((s) => s.text).join(' ');
    assert.doesNotMatch(joined, /commission|our fee|we keep|BuyHalfCow keeps/i);
  }
});

test('broker "today" step claims we told the ranch ONLY when delivery is confirmed', () => {
  assert.match(brokerSteps('delivered')[0].text, /We sent Granite Hollow your order/);
  for (const verdict of ['not-delivered', 'unknown'] as const) {
    const today = brokerSteps(verdict)[0].text;
    assert.doesNotMatch(today, /We sent Granite Hollow your order/, `${verdict}: unproven claim`);
    // Honest but not alarming: no "failed", no "bounced", no "error".
    assert.doesNotMatch(today, /fail|bounce|error|problem|could not/i, `${verdict}: stays calm`);
    assert.match(today, /reply to your receipt/i, `${verdict}: gives the buyer a real out`);
  }
});

test('broker "today" step defaults to the unproven wording when no verdict is passed', () => {
  const today = depositNextSteps({ rail: 'broker', rancherLabel: 'Granite Hollow' })[0].text;
  assert.doesNotMatch(today, /We sent Granite Hollow your order/);
});

// ── depositRailForReferral — the rail read the success page actually uses ────
//
// The rancher record is the authority, but the deposit GET reads it
// best-effort (`.catch(() => null)`) — and a null read must not silently
// downgrade a broker sale to the Connect story. The referral's own
// 'Match Type', stamped at mint, is the belt.

test('rail: broker rancher record wins', () => {
  assert.equal(
    depositRailForReferral({}, { 'Broker Rail': true }),
    'broker',
  );
});

test('rail: unreadable rancher record falls back to the referral Match Type', () => {
  assert.equal(
    depositRailForReferral({ 'Match Type': 'Broker — Deposit' }, null),
    'broker',
  );
});

test('rail: a Connect sale stays connect on every signal', () => {
  assert.equal(
    depositRailForReferral(
      { 'Match Type': 'Direct (Rancher Page) — Deposit' },
      { 'Stripe Connect Account Id': 'acct_x' },
    ),
    'connect',
  );
  assert.equal(depositRailForReferral({}, null), 'connect');
});
