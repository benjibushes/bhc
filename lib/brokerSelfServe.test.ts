// BROKER SELF-SERVE view model + gates (lib/brokerSelfServe) and the
// `Broker Self Serve` predicate (lib/brokerRail isBrokerSelfServe).
//
// Pins:
//   1. isBrokerSelfServe fails CLOSED in both directions — it requires BOTH
//      checkboxes (a self-serve tick on a non-broker ranch relaxes nothing)
//      and parses the Airtable checkbox strictly (a string 'false' is truthy
//      in JS and must still read as unchecked).
//   2. brokerSelfServeCutCards renders ONLY cuts assertBrokerEligible would
//      sell, with the exact-mode key set byte-stable beside a weight-priced
//      sibling's range keys (same contract as buildBrokerCheckoutInfo).
//   3. assertBrokerSelfServeReservable = the money gates PLUS the opt-in: an
//      otherwise-sellable broker ranch without the flag stays token-only.
//
// Synthetic ranch names throughout — the repo is PUBLIC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBrokerSelfServe, BROKER_SELF_SERVE_FIELD } from './brokerRail';
import {
  brokerSelfServeCutCards,
  buildBrokerSelfServeView,
  assertBrokerSelfServeReservable,
} from './brokerSelfServe';

function selfServeRancher(over: Record<string, any> = {}) {
  return {
    id: 'recBROKERSELF01',
    'Ranch Name': 'Granite Hollow Beef',
    'Broker Rail': true,
    'Broker Self Serve': true,
    'Quarter Price': 1050,
    'Quarter Deposit': 100,
    'Half Price': 1800,
    'Half Deposit': 200,
    ...over,
  };
}

// ── isBrokerSelfServe ────────────────────────────────────────────────────

test('isBrokerSelfServe requires BOTH Broker Rail and Broker Self Serve', () => {
  assert.equal(isBrokerSelfServe(selfServeRancher()), true);
  assert.equal(isBrokerSelfServe(selfServeRancher({ 'Broker Self Serve': undefined })), false);
  // A stray self-serve tick on a NON-broker ranch must relax nothing.
  assert.equal(isBrokerSelfServe({ 'Broker Self Serve': true }), false);
  assert.equal(isBrokerSelfServe(null), false);
  assert.equal(isBrokerSelfServe(undefined), false);
});

test('isBrokerSelfServe parses the checkbox strictly (same rules as isBrokerRancher)', () => {
  assert.equal(isBrokerSelfServe(selfServeRancher({ 'Broker Self Serve': 'true' })), true);
  // 'false' is a truthy STRING — must still read as unchecked.
  assert.equal(isBrokerSelfServe(selfServeRancher({ 'Broker Self Serve': 'false' })), false);
  assert.equal(isBrokerSelfServe(selfServeRancher({ 'Broker Self Serve': 1 })), false);
});

test('the field constant matches the live schema name verbatim', () => {
  assert.equal(BROKER_SELF_SERVE_FIELD, 'Broker Self Serve');
});

// ── brokerSelfServeCutCards ──────────────────────────────────────────────

test('EXACT cut card keeps the exact key set — no stray range keys', () => {
  const cards = brokerSelfServeCutCards(selfServeRancher());
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], {
    cut: 'quarter',
    label: 'Quarter Cow',
    priceCents: 105000,
    depositCents: 10000,
    balanceCents: 95000,
  });
  assert.deepEqual(cards[1], {
    cut: 'half',
    label: 'Half Cow',
    priceCents: 180000,
    depositCents: 20000,
    balanceCents: 160000,
  });
});

test('WEIGHT-PRICED cut card carries the range; exact sibling stays exact', () => {
  const cards = brokerSelfServeCutCards(selfServeRancher({ 'Half Price Max': 2100 }));
  const half = cards.find((c) => c.cut === 'half');
  const quarter = cards.find((c) => c.cut === 'quarter');
  assert.deepEqual(half, {
    cut: 'half',
    label: 'Half Cow',
    priceCents: 180000, // FLOOR
    depositCents: 20000, // deposit — EXACT in both modes
    balanceCents: 160000, // floor − deposit
    weightPriced: true,
    priceMaxCents: 210000,
    balanceMaxCents: 190000,
  });
  assert.ok(quarter && !('weightPriced' in quarter), 'exact sibling must keep the exact shape');
});

test('malformed Max sells EXACT — no range keys for that cut', () => {
  const cards = brokerSelfServeCutCards(selfServeRancher({ 'Half Price Max': 'garbage' }));
  const half = cards.find((c) => c.cut === 'half');
  assert.ok(half && !('weightPriced' in half));
});

test('unsellable cuts never render a card (fail closed, per money gate)', () => {
  // No deposit set → not sellable on this rail (never derived).
  assert.equal(
    brokerSelfServeCutCards(selfServeRancher({ 'Half Deposit': undefined })).length,
    1,
  );
  // Deposit >= price → configuration error, refuse.
  assert.equal(
    brokerSelfServeCutCards(selfServeRancher({ 'Quarter Deposit': 1050 })).length,
    1,
  );
  // Whole never priced here → never a whole card.
  assert.ok(!brokerSelfServeCutCards(selfServeRancher()).some((c) => c.cut === 'whole'));
});

test('a Connect footprint or a non-broker ranch yields ZERO cards', () => {
  assert.equal(
    brokerSelfServeCutCards(selfServeRancher({ 'Stripe Connect Account Id': 'acct_1X' })).length,
    0,
  );
  assert.equal(brokerSelfServeCutCards(selfServeRancher({ 'Broker Rail': undefined })).length, 0);
});

// ── buildBrokerSelfServeView ─────────────────────────────────────────────

test('pricingNote renders ONLY when a weight-priced cut exists', () => {
  const note = 'Priced per pound of hanging weight; halves typically hang 350–410 lbs.';
  const exact = buildBrokerSelfServeView(selfServeRancher({ 'Broker Pricing Note': note }));
  assert.equal(exact.pricingNote, '', 'exact-mode ranch has no weight pricing to explain');
  const ranged = buildBrokerSelfServeView(
    selfServeRancher({ 'Broker Pricing Note': note, 'Half Price Max': 2100 }),
  );
  assert.equal(ranged.pricingNote, note);
});

test('view carries balance note (with honest fallback), steps, and extra costs', () => {
  const view = buildBrokerSelfServeView(
    selfServeRancher({
      'Broker Balance Note': 'Cash or check at pickup.',
      'Broker Fulfillment Steps': '1. We call you\n2) Pick your cuts\n- Pick up at the ranch',
      'Broker Additional Costs': 'Butcher fee paid to the processor, about $1.10/lb.',
    }),
  );
  assert.equal(view.balanceNote, 'Cash or check at pickup.');
  assert.deepEqual(view.fulfillmentSteps, [
    'We call you',
    'Pick your cuts',
    'Pick up at the ranch',
  ]);
  assert.equal(view.additionalCosts, 'Butcher fee paid to the processor, about $1.10/lb.');

  const bare = buildBrokerSelfServeView(selfServeRancher());
  // The balance ALWAYS needs an instruction — fallback, never blank.
  assert.ok(bare.balanceNote.length > 0);
  assert.deepEqual(bare.fulfillmentSteps, []);
  assert.equal(bare.additionalCosts, '');
});

// ── assertBrokerSelfServeReservable ──────────────────────────────────────

test('sellable + opted-in → ok with the standard broker quote', () => {
  const gate = assertBrokerSelfServeReservable(selfServeRancher(), 'half');
  assert.equal(gate.ok, true);
  if (gate.ok) {
    assert.equal(gate.quote.depositCents, 20000);
    assert.equal(gate.quote.balanceCents, 160000);
  }
});

test('sellable broker ranch WITHOUT the flag → 409 (stays token-only)', () => {
  const gate = assertBrokerSelfServeReservable(
    selfServeRancher({ 'Broker Self Serve': undefined }),
    'half',
  );
  assert.equal(gate.ok, false);
  if (!gate.ok) {
    assert.equal(gate.status, 409);
    assert.equal(gate.code, 'self_serve_unavailable');
  }
});

test('non-broker / unsellable / bad-cut / missing keep assertBrokerEligible statuses', () => {
  const nonBroker = assertBrokerSelfServeReservable(
    selfServeRancher({ 'Broker Rail': undefined }),
    'half',
  );
  assert.ok(!nonBroker.ok && nonBroker.status === 409 && nonBroker.code === 'not_broker_rail');

  const unsellable = assertBrokerSelfServeReservable(
    selfServeRancher({ 'Half Deposit': undefined }),
    'half',
  );
  assert.ok(!unsellable.ok && unsellable.status === 409 && unsellable.code === 'no_deposit');

  const badCut = assertBrokerSelfServeReservable(selfServeRancher(), 'sirloin' as any);
  assert.ok(!badCut.ok && badCut.status === 400);

  const missing = assertBrokerSelfServeReservable(null, 'half');
  assert.ok(!missing.ok && missing.status === 404);
});
