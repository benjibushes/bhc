// BROKER RAIL — Meta conversion events.
//
// The gap these close: settleBrokerDeposit fired NOTHING. Every deposit on a
// represented ranch was invisible to Meta — no intent signal, no conversion, no
// way to optimize the ads pointed at those pages.
//
// What's pinned here, hardest first:
//   1. THE VALUE IS THE DEPOSIT, NOT THE SHARE PRICE. On this rail the buyer's
//      card is charged the deposit and nothing else (the balance goes to the
//      ranch off-platform). Reporting the price would inflate the conversion
//      value ~4-5x against real spend AND disagree with the success page's
//      client Purchase, which reads the settled charge. See lib/brokerCapi.
//   2. THE EVENT IDS. InitiateCheckout uses the raw referral id; Purchase uses
//      `deposit_<refId>` — the exact id the success-page Pixel fires, so the
//      pair dedups into ONE Purchase instead of double-counting.
//   3. THE PURCHASE IS DARK BY DEFAULT. It only exists when the caller passes
//      the env-authoritative depositPurchaseEnabled() gate as true.
//   4. fbc RIDES. The whole point of persisting fbclid/fbclid_ts at consumer
//      creation is that this event carries a real match key.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrokerCapiUserData, buildBrokerDepositCapiEvents } from './brokerCapi';
import { depositEventId } from './metaCapi';

const REF = 'recBROKERREF001';
const NOW_MS = 1_755_300_000_000;

const CONSUMER = {
  id: 'recBUYER0001',
  Email: 'Buyer@Example.com',
  'Full Name': 'Jo Sample Buyer',
  Phone: '+15551234567',
  State: 'AZ',
  fbclid: 'IwAR0testclickid',
  fbclid_ts: '1755200000000',
};

const REFERRAL = {
  id: REF,
  'Buyer Email': 'referral-fallback@example.com',
  'Buyer Name': 'Referral Fallback',
  'Buyer Phone': '+15559990000',
  'Order Type': 'Half Cow',
};

function build(over: Record<string, any> = {}) {
  return buildBrokerDepositCapiEvents({
    referralId: REF,
    depositCents: 40000, // $400 charged
    consumer: CONSUMER,
    referral: REFERRAL,
    cutLabel: 'Half Cow',
    purchaseEnabled: false,
    nowMs: NOW_MS,
    ...over,
  });
}

// ── Which events fire ──────────────────────────────────────────────────────

test('InitiateCheckout ALWAYS fires — the intent signal is never gated', () => {
  const events = build();
  assert.equal(events.length, 1);
  assert.equal(events[0].event_name, 'InitiateCheckout');
  // Raw referral id = the repo-wide dedup convention (lib/analytics metaEventId),
  // matching the Connect rail so both rails share one event stream.
  assert.equal(events[0].event_id, REF);
  assert.equal(events[0].action_source, 'system_generated');
  assert.equal(events[0].event_time, Math.floor(NOW_MS / 1000));
});

test('Purchase is DARK unless the deposit flag is on', () => {
  assert.equal(build({ purchaseEnabled: false }).some((e) => e.event_name === 'Purchase'), false);
  const on = build({ purchaseEnabled: true });
  assert.equal(on.length, 2);
  assert.equal(on[1].event_name, 'Purchase');
});

test('Purchase event_id is deposit_<refId> — dedups with the success-page Pixel', () => {
  const purchase = build({ purchaseEnabled: true }).find((e) => e.event_name === 'Purchase')!;
  assert.equal(purchase.event_id, `deposit_${REF}`);
  assert.equal(purchase.event_id, depositEventId(REF));
  // Client mirror in app/checkout/[refId]/success/page.tsx builds the same
  // string literally (it can't import node crypto). Pin the literal too.
});

test('the two events use DISTINCT ids — one is intent, one is a conversion', () => {
  const [ic, purchase] = build({ purchaseEnabled: true });
  assert.notEqual(ic.event_id, purchase.event_id);
});

// ── THE VALUE DECISION ─────────────────────────────────────────────────────

test('value is the DEPOSIT the buyer was charged, never the share price', () => {
  // A $1,800 half with a $400 deposit: the card statement says $400 and BHC's
  // revenue is $400. $1,800 would be a fiction the bidder optimizes against.
  const events = build({ depositCents: 40000, purchaseEnabled: true });
  for (const e of events) {
    assert.equal(e.custom_data?.value, 400);
    assert.equal(e.custom_data?.currency, 'usd');
  }
});

test('InitiateCheckout and Purchase report the SAME value (no drift)', () => {
  const [ic, purchase] = build({ depositCents: 62500, purchaseEnabled: true });
  assert.equal(ic.custom_data?.value, 625);
  assert.equal(purchase.custom_data?.value, 625);
});

test('a missing / absurd deposit reports 0, never NaN or a negative', () => {
  for (const cents of [0, -1, Number.NaN, undefined as any, null as any, 'oops' as any]) {
    const e = build({ depositCents: cents })[0];
    assert.equal(e.custom_data?.value, 0, `depositCents=${String(cents)}`);
  }
});

test('content_category matches the Connect rail so deposits pool as one signal', () => {
  assert.equal(build()[0].custom_data?.content_category, 'buyer-deposit');
  assert.equal(build()[0].custom_data?.content_name, 'Beef deposit — Half Cow');
  assert.equal(build({ cutLabel: '' })[0].custom_data?.content_name, 'Beef deposit');
});

test('nothing in the event copy reveals that the deposit is the commission', () => {
  // Only the human-readable copy fields — record ids are opaque identifiers,
  // not copy. Rail-safe framing is a hard rule on this rail (lib/brokerRail).
  const copy = build({ purchaseEnabled: true })
    .map((e) => `${e.custom_data?.content_name} ${e.custom_data?.content_category}`)
    .join(' ')
    .toLowerCase();
  for (const word of ['commission', 'fee', 'markup', 'broker']) {
    assert.ok(!copy.includes(word), `event copy must not contain "${word}" (got: ${copy})`);
  }
});

// ── Match keys ─────────────────────────────────────────────────────────────

test('fbc is rebuilt from the buyer stored click id + click TIMESTAMP', () => {
  const ud = buildBrokerCapiUserData(CONSUMER, REFERRAL);
  assert.equal(ud.fbc, 'fb.1.1755200000000.IwAR0testclickid');
});

test('no fbclid_ts → NO fbc at all (a bare fbclid does not match)', () => {
  assert.equal(buildBrokerCapiUserData({ ...CONSUMER, fbclid_ts: '' }).fbc, undefined);
  assert.equal(buildBrokerCapiUserData({ ...CONSUMER, fbclid: '' }).fbc, undefined);
});

test('identity is HASHED, never sent in the clear (repo is public, PII rule)', () => {
  const ud = buildBrokerCapiUserData(CONSUMER, REFERRAL);
  const blob = JSON.stringify(ud);
  assert.ok(!blob.includes('Buyer@Example.com'));
  assert.ok(!blob.toLowerCase().includes('buyer@example.com'));
  assert.ok(!blob.includes('5551234567'));
  assert.ok(!blob.includes('Jo'));
  // sha256 hex, in the array shape Meta expects.
  assert.ok(Array.isArray(ud.em) && /^[a-f0-9]{64}$/.test(ud.em[0]));
  assert.ok(Array.isArray(ud.ph) && /^[a-f0-9]{64}$/.test(ud.ph[0]));
});

test('an unreadable Consumer falls back to the referral for buyer identity', () => {
  const ud = buildBrokerCapiUserData(null, REFERRAL);
  assert.ok(Array.isArray(ud.em) && ud.em.length === 1, 'email still present via the referral');
  assert.equal(ud.fbc, undefined, 'no consumer row means no stored click id');
});

test('no consumer AND no referral still yields a valid (thin) event', () => {
  const events = buildBrokerDepositCapiEvents({
    referralId: REF,
    depositCents: 40000,
    consumer: null,
    referral: null,
    purchaseEnabled: true,
    nowMs: NOW_MS,
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].event_id, REF);
  // buildUserData always stamps hashed country; nothing is undefined-crashed.
  assert.ok(events[0].user_data);
});

test('no fbp is fabricated — a Stripe webhook has no browser cookies', () => {
  assert.equal('fbp' in buildBrokerCapiUserData(CONSUMER, REFERRAL), false);
});
