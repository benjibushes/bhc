import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { adminFulfillmentCloseDecision } from './fulfillmentConfirm';
import { BROKER_MATCH_TYPE } from './brokerRail';

// ──────────────────────────────────────────────────────────────────────────
// P0-1 — A BROKER DEAL COULD NEVER BE CLOSED.
//
// `Fulfillment Confirmed At` is written in exactly one place
// (lib/fulfillmentConfirm confirmFulfillmentForReferral) and was reachable
// only from two rancher-SESSION routes. A represented ranch has NO session by
// construction — no agreement, no dashboard login, no Stripe Connect — so a
// paid broker deposit parked at 'Awaiting Payment' forever. The Telegram close
// path refused it too, on a commission-rate gate a represented ranch can never
// satisfy and must never need.
//
// Synthetic ids throughout — the repo is PUBLIC.
// ──────────────────────────────────────────────────────────────────────────

function brokerRef(over: Record<string, any> = {}) {
  return {
    'Match Type': BROKER_MATCH_TYPE,
    'Status': 'Awaiting Payment',
    'Deposit Paid At': '2026-08-17T12:00:00.000Z',
    'Total Sale Amount': 1800,
    ...over,
  };
}

function connectRef(over: Record<string, any> = {}) {
  return {
    'Match Type': 'Direct (Rancher Page) — Deposit',
    'Status': 'Awaiting Payment',
    'Deposit Paid At': '2026-08-17T12:00:00.000Z',
    'Total Sale Amount': 1800,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// BROKER — fulfillment confirm IS the last event in the deal
// ---------------------------------------------------------------------------

test('BROKER: confirming fulfillment closes the deal Closed Won', () => {
  // Nothing else ever will. There is no final invoice on this rail — the buyer
  // pays the ranch direct at pickup, off platform.
  const d = adminFulfillmentCloseDecision(brokerRef());
  assert.equal(d.close, true);
  if (!d.close) return;
  assert.equal(d.rail, 'broker');
  assert.equal(d.outcome, 'won');
});

test('BROKER: Commission Due is structurally impossible to write', () => {
  const d = adminFulfillmentCloseDecision(brokerRef());
  assert.equal(d.close, true);
  if (!d.close) return;
  // A represented rancher signed no agreement and is never invoiced. The type
  // pins this to the literal `false`, not merely a falsy default.
  assert.equal(d.writeCommissionDue, false);
});

test('BROKER: the sale amount defaults to the price stamped at settlement', () => {
  const d = adminFulfillmentCloseDecision(brokerRef());
  assert.equal(d.close && d.saleAmount, 1800);
});

test('BROKER: an already-agreed Sale Amount outranks the settlement stamp', () => {
  const d = adminFulfillmentCloseDecision(brokerRef({ 'Sale Amount': 1950 }));
  assert.equal(d.close && d.saleAmount, 1950);
});

test('BROKER: the operator override outranks everything — hanging weight', () => {
  // A WEIGHT-PRICED represented ranch only learns the exact price when the
  // carcass is weighed, which is this moment. Total Sale Amount is the range
  // FLOOR, so without the override the sale would be understated on every
  // weight-priced close.
  const d = adminFulfillmentCloseDecision(brokerRef({ 'Sale Amount': 1950 }), {
    saleAmountOverride: 2140,
  });
  assert.equal(d.close && d.saleAmount, 2140);
});

test('BROKER: with no usable price it closes WITHOUT stamping a made-up zero', () => {
  const d = adminFulfillmentCloseDecision(brokerRef({ 'Total Sale Amount': 0 }));
  assert.equal(d.close, true);
  if (!d.close) return;
  assert.equal(d.saleAmount, undefined, 'a stamped 0 reads as a free cow in every revenue surface');
});

test('BROKER: garbage prices are ignored rather than propagated', () => {
  for (const bad of [null, '', 'abc', -50, NaN]) {
    const d = adminFulfillmentCloseDecision(brokerRef({ 'Total Sale Amount': bad, 'Sale Amount': bad }));
    assert.equal(d.close && d.saleAmount, undefined, `rejected: ${String(bad)}`);
  }
});

test('BROKER: an already-terminal referral is a no-op in every terminal state', () => {
  for (const status of ['Closed Won', 'Closed Lost', 'Refunded']) {
    const d = adminFulfillmentCloseDecision(brokerRef({ 'Status': status }));
    assert.equal(d.close, false, `${status} must not re-close`);
    assert.match(d.close === false ? d.reason : '', /already terminal/);
  }
});

// ---------------------------------------------------------------------------
// CONNECT — byte-identical to what the rancher-session routes already do
// ---------------------------------------------------------------------------

test('CONNECT: confirming fulfillment NEVER closes the deal', () => {
  // The Connect close arrives with the balance: final invoice paid →
  // settleFinalInvoice → recordClose, with the real sale amount and the whole
  // commission machinery. Closing here would pre-empt all of it.
  const d = adminFulfillmentCloseDecision(connectRef());
  assert.equal(d.close, false);
  assert.equal(d.rail, 'connect');
  assert.match(d.close === false ? d.reason : '', /final invoice/);
});

test('CONNECT: not even an operator sale-amount override can force a close', () => {
  const d = adminFulfillmentCloseDecision(connectRef(), { saleAmountOverride: 2500 });
  assert.equal(d.close, false);
});

test('CONNECT: a legacy row with no Match Type at all stays on the connect path', () => {
  assert.equal(adminFulfillmentCloseDecision({ 'Status': 'Awaiting Payment' }).close, false);
  assert.equal(adminFulfillmentCloseDecision({}).close, false);
  assert.equal(adminFulfillmentCloseDecision(null).close, false);
});

test('the rail read fails CLOSED — near-miss Match Types are NOT broker', () => {
  // A wrong 'broker' read would close a Connect deal early AND skip its
  // Commission Due, destroying a live receivable.
  for (const mt of ['Broker', 'broker — deposit', 'Broker—Deposit', 'Direct (Rancher Page) — Deposit']) {
    assert.equal(adminFulfillmentCloseDecision(brokerRef({ 'Match Type': mt })).rail, 'connect', mt);
  }
  // Airtable's {name} singleSelect object form IS accepted.
  assert.equal(
    adminFulfillmentCloseDecision(brokerRef({ 'Match Type': { name: BROKER_MATCH_TYPE } })).rail,
    'broker',
  );
});

// ---------------------------------------------------------------------------
// WIRING PINS — the I/O halves cannot be unit-run, so pin what a refactor
// could silently revert. Same technique as lib/brokerSettlement.test.ts.
// ---------------------------------------------------------------------------

const confirmSrc = readFileSync(fileURLToPath(new URL('./fulfillmentConfirm.ts', import.meta.url)), 'utf8');
const routeSrc = readFileSync(
  fileURLToPath(new URL('../app/api/admin/referrals/[id]/confirm-fulfillment/route.ts', import.meta.url)),
  'utf8',
);
const telegramSrc = readFileSync(
  fileURLToPath(new URL('../app/api/webhooks/telegram/route.ts', import.meta.url)),
  'utf8',
);

test('the admin route exists and is ADMIN-authenticated like its siblings', () => {
  assert.match(routeSrc, /export async function POST\(/);
  assert.match(routeSrc, /const unauthorized = await requireAdmin\(request\);/);
  assert.match(routeSrc, /if \(unauthorized\) return unauthorized;/);
  // The auth check must be the FIRST thing — before the referral is even read.
  const authAt = routeSrc.indexOf('await requireAdmin(request)');
  const readAt = routeSrc.indexOf('getRecordById(TABLES.REFERRALS');
  assert.ok(authAt > 0 && readAt > authAt, 'nothing may happen before auth');
});

test('the admin route runs the SAME confirm rail — it does not hand-roll a stamp', () => {
  // A second writer of 'Fulfillment Confirmed At' would skip the payment gate,
  // the buyer email, the funnel event and the operator alert.
  assert.match(routeSrc, /await confirmFulfillmentAsAdmin\(\{/);
  assert.ok(
    !/updateRecord\(/.test(routeSrc),
    'the route writes NOTHING itself — the stamp stays in lib/fulfillmentConfirm, its one writer',
  );
});

test('the admin helper resolves the rancher from the REFERRAL, not a session', () => {
  // This is the whole point: a represented ranch has no session to resolve.
  const helper = confirmSrc.slice(confirmSrc.indexOf('export async function confirmFulfillmentAsAdmin'));
  assert.match(helper, /const rancherLinks: string\[\] = \(referral\['Rancher'\] \|\| \[\]\) as string\[\];/);
  assert.ok(!/requireRancher|session\./.test(helper), 'no session may be consulted');
  assert.match(helper, /await confirmFulfillmentForReferral\(\{/, 'the payment gate is deliberately kept');
});

test('the broker close goes through recordClose — capacity, buyer stage, funnel', () => {
  // recordClose is the single source of truth for a close, and its capacity
  // DECR is what finally frees the ranch's slot ('Awaiting Payment' IS in the
  // canonical held set, so a broker sale holds one until this runs).
  const helper = confirmSrc.slice(confirmSrc.indexOf('export async function confirmFulfillmentAsAdmin'));
  assert.match(helper, /const \{ recordClose \} = await import\('@\/lib\/contracts\/rancher'\);/);
  assert.match(helper, /outcome: decision\.outcome/);
  assert.ok(
    !/'Commission Due':/.test(helper),
    'the admin close must never write a Commission Due field — recordClose does not either',
  );
});

test('a close failure never discards the confirmation that already landed', () => {
  const helper = confirmSrc.slice(confirmSrc.indexOf('export async function confirmFulfillmentAsAdmin'));
  assert.match(helper, /broker close failed/, 'the close call site stays try-caught');
  assert.match(helper, /Fulfillment IS stamped — re-run to close\./);
});

// ── The Telegram close path ────────────────────────────────────────────────

test('TELEGRAM: the commission-rate gate no longer refuses a broker close', () => {
  // THE BUG: `if (!hasLockedCommissionRate(rancher))` refused every broker
  // close, on a field a represented ranch must never have.
  assert.match(telegramSrc, /const brokerRow = isBrokerReferralRow\(ref\);/);
  assert.match(
    telegramSrc,
    /if \(!brokerRow && !hasLockedCommissionRate\(rancher\)\) \{/,
    'the gate must be skipped entirely on the broker rail',
  );
  assert.ok(
    !/\n\s+if \(!hasLockedCommissionRate\(rancher\)\) \{\n\s+await sendTelegramMessage\(\n\s+chatId,\n\s+`🚫 <b>Refused close<\/b>/.test(
      telegramSrc,
    ),
    'the unconditional refusal must not come back',
  );
});

test('TELEGRAM: a broker close writes NO Commission Due', () => {
  assert.match(
    telegramSrc,
    /\.\.\.\(brokerRow \? \{\} : \{ 'Commission Due': commission \}\),/,
    'the field must be conditionally spread, never written flat',
  );
});

test('TELEGRAM: a represented ranch is never emailed a commission invoice', () => {
  assert.match(telegramSrc, /if \(!brokerRow && rancher\['Email'\]\) \{/);
});

test('TELEGRAM: the celebration reports the deposit BHC actually kept', () => {
  // commission is 0 on this rail by construction; reporting that would
  // understate the month by the entire broker take.
  assert.match(telegramSrc, /commission: brokerRow \? brokerFeeDollars\(ref\) : commission,/);
});
