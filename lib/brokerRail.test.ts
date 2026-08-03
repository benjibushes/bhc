import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isBrokerRancher,
  rancherHasConnectAccount,
  brokerBalanceNote,
  brokerFulfillmentSteps,
  brokerAdditionalCosts,
  BROKER_FULFILLMENT_STEPS_FIELD,
  BROKER_ADDITIONAL_COSTS_FIELD,
  BROKER_FULFILLMENT_STEPS_MAX,
  assertBrokerEligible,
  isBrokerRailMetadata,
  referralRailForRancher,
  excludeBrokerRanchers,
  BROKER_BALANCE_NOTE_FALLBACK,
  BROKER_MATCH_TYPE,
  CUT_LABELS,
} from './brokerRail';
import { CUT_LABELS as RESERVE_CUT_LABELS } from './reserveDeposit';

// A minimal VALID broker rancher: represented, no Connect, priced, with a
// deposit strictly below the price. Synthetic name — the repo is PUBLIC.
function brokerRancher(over: Record<string, any> = {}) {
  return {
    id: 'recBROKER0000001',
    'Ranch Name': 'Cedar Draw Beef',
    'Broker Rail': true,
    'Half Price': 1800,
    'Half Deposit': 400,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// isBrokerRancher — parsed exactly, both directions matter
// ---------------------------------------------------------------------------

test('isBrokerRancher: true only for a genuinely checked box', () => {
  assert.equal(isBrokerRancher({ 'Broker Rail': true }), true);
  assert.equal(isBrokerRancher({ 'Broker Rail': 'true' }), true);
  assert.equal(isBrokerRancher({ 'Broker Rail': 'TRUE' }), true);
});

test('isBrokerRancher: false for unchecked / absent / falsy-string', () => {
  // Airtable omits the key entirely when a checkbox is unchecked.
  assert.equal(isBrokerRancher({}), false);
  assert.equal(isBrokerRancher({ 'Broker Rail': false }), false);
  assert.equal(isBrokerRancher({ 'Broker Rail': null }), false);
  assert.equal(isBrokerRancher(null), false);
  assert.equal(isBrokerRancher(undefined), false);
  // 'false' is TRUTHY in JS — the bug this parser exists to prevent.
  assert.equal(isBrokerRancher({ 'Broker Rail': 'false' }), false);
});

// ---------------------------------------------------------------------------
// Cut labels must not drift from lib/reserveDeposit (restated for hermeticity)
// ---------------------------------------------------------------------------

test('CUT_LABELS stay identical to lib/reserveDeposit (hermetic copy, must not drift)', () => {
  assert.deepEqual(CUT_LABELS, RESERVE_CUT_LABELS);
});

// ---------------------------------------------------------------------------
// GATE: broker rail flag
// ---------------------------------------------------------------------------

test('GATE broker-rail: refuses a rancher who is not flagged Broker Rail', () => {
  const r = assertBrokerEligible(brokerRancher({ 'Broker Rail': false }), 'half');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'not_broker_rail');
  assert.equal(r.ok === false && r.status, 409);
});

test('GATE broker-rail: accepts a fully configured broker rancher', () => {
  const r = assertBrokerEligible(brokerRancher(), 'half');
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.quote.priceCents, 180000);
  assert.equal(r.ok === true && r.quote.depositCents, 40000);
  // The balance is what the rancher collects AND what he nets.
  assert.equal(r.ok === true && r.quote.balanceCents, 140000);
});

// ---------------------------------------------------------------------------
// GATE: no Connect account — double-billing refusal
// ---------------------------------------------------------------------------

test('GATE connect: REFUSES a broker rancher who has a Connect account id', () => {
  const r = assertBrokerEligible(
    brokerRancher({ 'Stripe Connect Account Id': 'acct_123' }),
    'half',
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'connect_rancher');
});

test('GATE connect: REFUSES on a Connect status alone (no account id yet)', () => {
  const r = assertBrokerEligible(brokerRancher({ 'Stripe Connect Status': 'active' }), 'half');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'connect_rancher');
});

test('GATE connect: REFUSES a tier_v2 rancher even with no account id or status', () => {
  const r = assertBrokerEligible(brokerRancher({ 'Pricing Model': 'tier_v2' }), 'half');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'connect_rancher');
});

test('GATE connect: a blank/none Connect status does NOT count as a footprint', () => {
  assert.equal(rancherHasConnectAccount({ 'Stripe Connect Status': '' }), false);
  assert.equal(rancherHasConnectAccount({ 'Stripe Connect Status': 'none' }), false);
  assert.equal(assertBrokerEligible(brokerRancher({ 'Stripe Connect Status': '' }), 'half').ok, true);
});

// ---------------------------------------------------------------------------
// GATE: the cut must be priced
// ---------------------------------------------------------------------------

test('GATE priced: refuses a cut with no price', () => {
  const r = assertBrokerEligible(brokerRancher(), 'whole'); // only Half is priced
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'cut_unpriced');
});

test('GATE priced: refuses a per-lb value typed into a total field', () => {
  // The "$7.40 whole cow" class of bug (a per-lb value typed into a total
  // field, seen live once) — never charge it.
  const r = assertBrokerEligible(
    brokerRancher({ 'Whole Price': 7.4, 'Whole Deposit': 2 }),
    'whole',
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'price_implausible');
});

// ---------------------------------------------------------------------------
// GATE: the cut must have an EXPLICIT deposit (never derived on this rail)
// ---------------------------------------------------------------------------

test('GATE deposit: refuses a priced cut with NO deposit — never derives one', () => {
  // On the Connect rail a missing deposit falls back to deriveDeposit (25%).
  // Here the deposit IS Ben's commission, so deriving would invent his fee.
  const r = assertBrokerEligible(
    brokerRancher({ 'Half Price': 1800, 'Half Deposit': undefined }),
    'half',
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'no_deposit');
});

test('GATE deposit: refuses a zero or negative deposit', () => {
  assert.equal(
    assertBrokerEligible(brokerRancher({ 'Half Deposit': 0 }), 'half').ok,
    false,
  );
  assert.equal(
    assertBrokerEligible(brokerRancher({ 'Half Deposit': -100 }), 'half').ok,
    false,
  );
});

// ---------------------------------------------------------------------------
// GATE: deposit MUST be strictly less than price (config error otherwise)
// ---------------------------------------------------------------------------

test('GATE deposit<price: refuses a deposit EQUAL to the price', () => {
  const r = assertBrokerEligible(
    brokerRancher({ 'Half Price': 1800, 'Half Deposit': 1800 }),
    'half',
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'deposit_exceeds_price');
});

test('GATE deposit<price: refuses a deposit ABOVE the price', () => {
  const r = assertBrokerEligible(
    brokerRancher({ 'Half Price': 1800, 'Half Deposit': 2000 }),
    'half',
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'deposit_exceeds_price');
});

test('GATE deposit<price: a deposit one dollar under the price is allowed', () => {
  const r = assertBrokerEligible(
    brokerRancher({ 'Half Price': 1800, 'Half Deposit': 1799 }),
    'half',
  );
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.quote.balanceCents, 100);
});

test('GATE cut: refuses a bogus cut name with a 400', () => {
  const r = assertBrokerEligible(brokerRancher(), 'eighth' as any);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 400);
});

test('GATE: a missing rancher record is a 404, never a charge', () => {
  const r = assertBrokerEligible(null, 'half');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 404);
});

// ---------------------------------------------------------------------------
// THE MONEY IDENTITY — the whole rail in one assertion
// ---------------------------------------------------------------------------

test('MONEY: buyer total == price; BHC keeps the deposit; rancher nets price - deposit', () => {
  const r = assertBrokerEligible(brokerRancher({ 'Half Price': 1800, 'Half Deposit': 400 }), 'half');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const { priceCents, depositCents, balanceCents } = r.quote;
  const bhcKeeps = depositCents;          // 100% of the charge, no split
  const rancherNets = balanceCents;       // collected direct from the buyer
  const buyerPaysTotal = depositCents + balanceCents;
  assert.equal(buyerPaysTotal, priceCents, 'buyer total must equal the full share price');
  assert.equal(bhcKeeps + rancherNets, priceCents, 'price splits exactly into commission + net');
  assert.equal(bhcKeeps, 40000);
  assert.equal(rancherNets, 140000);
});

test('MONEY: cents conversion survives fractional dollar prices', () => {
  const r = assertBrokerEligible(
    brokerRancher({ 'Half Price': 1799.99, 'Half Deposit': 400.5 }),
    'half',
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.quote.priceCents, 179999);
  assert.equal(r.quote.depositCents, 40050);
  assert.equal(r.quote.balanceCents, 139949);
});

// ---------------------------------------------------------------------------
// Rail identification — FAIL CLOSED
// ---------------------------------------------------------------------------

test('isBrokerRailMetadata: exact match only', () => {
  assert.equal(isBrokerRailMetadata({ rail: 'broker' }), true);
  assert.equal(isBrokerRailMetadata({ rail: 'Broker' }), false);
  assert.equal(isBrokerRailMetadata({ rail: 'broker ' }), false);
  assert.equal(isBrokerRailMetadata({ rail: '' }), false);
  assert.equal(isBrokerRailMetadata({}), false);
  assert.equal(isBrokerRailMetadata(null), false);
  // A Connect deposit's metadata must never be read as broker.
  assert.equal(isBrokerRailMetadata({ type: 'buyer_deposit', tier: 'ranch' }), false);
});

test('referralRailForRancher: broker, connect, and the ambiguous refusal', () => {
  assert.equal(referralRailForRancher(brokerRancher()), 'broker');
  assert.equal(
    referralRailForRancher({ 'Stripe Connect Account Id': 'acct_1', 'Pricing Model': 'tier_v2' }),
    'connect',
  );
  // Flagged BOTH — a data error a human resolves, never a coin flip with money.
  assert.equal(
    referralRailForRancher(brokerRancher({ 'Stripe Connect Account Id': 'acct_1' })),
    'ambiguous',
  );
  // Unreadable rancher is ambiguous, NOT 'connect' — fail closed.
  assert.equal(referralRailForRancher(null), 'ambiguous');
  assert.equal(referralRailForRancher(undefined), 'ambiguous');
});

// ---------------------------------------------------------------------------
// Balance note
// ---------------------------------------------------------------------------

test('brokerBalanceNote: uses the rancher note, else honest fallback copy', () => {
  assert.equal(
    brokerBalanceNote({ 'Broker Balance Note': 'Cash or check at pickup.' }),
    'Cash or check at pickup.',
  );
  assert.equal(brokerBalanceNote({ 'Broker Balance Note': '   ' }), BROKER_BALANCE_NOTE_FALLBACK);
  assert.equal(brokerBalanceNote({}), BROKER_BALANCE_NOTE_FALLBACK);
});

// ---------------------------------------------------------------------------
// Fulfillment transparency
// ---------------------------------------------------------------------------

test('field constants match the live Airtable schema exactly', () => {
  assert.equal(BROKER_FULFILLMENT_STEPS_FIELD, 'Broker Fulfillment Steps');
  assert.equal(BROKER_ADDITIONAL_COSTS_FIELD, 'Broker Additional Costs');
});

test('brokerFulfillmentSteps: splits on newlines, trims, and drops blank lines', () => {
  const steps = brokerFulfillmentSteps({
    [BROKER_FULFILLMENT_STEPS_FIELD]:
      '  The ranch calls you within two days.\n\n   You choose your cuts.  \r\n\r\nYou pick up your beef.\n   ',
  });
  assert.deepEqual(steps, [
    'The ranch calls you within two days.',
    'You choose your cuts.',
    'You pick up your beef.',
  ]);
});

test('brokerFulfillmentSteps: strips hand-typed list markers so an ordered list never doubles up', () => {
  const steps = brokerFulfillmentSteps({
    [BROKER_FULFILLMENT_STEPS_FIELD]: '1. Call the ranch\n2) Choose your cuts\n- Pick up\n• Enjoy',
  });
  assert.deepEqual(steps, ['Call the ranch', 'Choose your cuts', 'Pick up', 'Enjoy']);
});

test('brokerFulfillmentSteps: a step that only LOOKS numeric keeps its text', () => {
  // "12 lbs per box" must not lose its leading number — only a marker followed
  // by whitespace ("12. " / "12) ") is a list marker.
  assert.deepEqual(
    brokerFulfillmentSteps({ [BROKER_FULFILLMENT_STEPS_FIELD]: '12 lbs per box' }),
    ['12 lbs per box'],
  );
});

test('brokerFulfillmentSteps: caps the list rather than printing a manual', () => {
  const many = Array.from({ length: 20 }, (_, i) => `Step ${i + 1}`).join('\n');
  const steps = brokerFulfillmentSteps({ [BROKER_FULFILLMENT_STEPS_FIELD]: many });
  assert.equal(steps.length, BROKER_FULFILLMENT_STEPS_MAX);
  assert.equal(steps[0], 'Step 1');
});

test('brokerFulfillmentSteps: unset / blank / non-string all yield [] — never a fallback sentence', () => {
  assert.deepEqual(brokerFulfillmentSteps({}), []);
  assert.deepEqual(brokerFulfillmentSteps(undefined), []);
  assert.deepEqual(brokerFulfillmentSteps(null), []);
  assert.deepEqual(brokerFulfillmentSteps({ [BROKER_FULFILLMENT_STEPS_FIELD]: '' }), []);
  assert.deepEqual(brokerFulfillmentSteps({ [BROKER_FULFILLMENT_STEPS_FIELD]: '  \n \n ' }), []);
  assert.deepEqual(brokerFulfillmentSteps({ [BROKER_FULFILLMENT_STEPS_FIELD]: 42 }), []);
  assert.deepEqual(brokerFulfillmentSteps({ [BROKER_FULFILLMENT_STEPS_FIELD]: ['a'] }), []);
});

test('brokerAdditionalCosts: returns the trimmed text, and "" when the price is all-in', () => {
  assert.equal(
    brokerAdditionalCosts({ [BROKER_ADDITIONAL_COSTS_FIELD]: '  Processing is billed by the butcher.  ' }),
    'Processing is billed by the butcher.',
  );
  // Multiline text survives intact (only the outer edges are trimmed).
  assert.equal(
    brokerAdditionalCosts({ [BROKER_ADDITIONAL_COSTS_FIELD]: 'Line one\nLine two' }),
    'Line one\nLine two',
  );
  assert.equal(brokerAdditionalCosts({}), '');
  assert.equal(brokerAdditionalCosts(undefined), '');
  assert.equal(brokerAdditionalCosts({ [BROKER_ADDITIONAL_COSTS_FIELD]: '   ' }), '');
  // Never the literal string "undefined" — that would print as buyer-facing copy.
  assert.equal(brokerAdditionalCosts({ [BROKER_ADDITIONAL_COSTS_FIELD]: undefined }), '');
});

test('fulfillment fields do NOT affect eligibility or the money', () => {
  // Disclosure is disclosure. A ranch with a third-party cost is still sellable,
  // and the quote is byte-identical to the same ranch without one.
  const plain = assertBrokerEligible(brokerRancher(), 'half');
  const withExtras = assertBrokerEligible(
    brokerRancher({
      [BROKER_FULFILLMENT_STEPS_FIELD]: 'Call the ranch\nPick up your beef',
      [BROKER_ADDITIONAL_COSTS_FIELD]: 'Processing runs about $450 on a half.',
    }),
    'half',
  );
  assert.ok(plain.ok && withExtras.ok);
  assert.deepEqual(withExtras.quote, plain.quote);
});

// ---------------------------------------------------------------------------
// GUARDRAIL helper
// ---------------------------------------------------------------------------

test('excludeBrokerRanchers: drops represented ranchers, keeps everyone else', () => {
  const rows = [
    { id: 'a', 'Broker Rail': true },
    { id: 'b' },
    { id: 'c', 'Broker Rail': false },
    { id: 'd', 'Broker Rail': true },
  ];
  assert.deepEqual(excludeBrokerRanchers(rows).map((r: any) => r.id), ['b', 'c']);
});

test('excludeBrokerRanchers: tolerates a non-array (degraded read) without throwing', () => {
  assert.deepEqual(excludeBrokerRanchers(null as any), []);
  assert.deepEqual(excludeBrokerRanchers(undefined as any), []);
});

test('BROKER_MATCH_TYPE contains "Deposit" so deposit-intent filters still match it', () => {
  // lib/campaignReferral reuses referrals whose Match Type includes 'Deposit'.
  assert.ok(BROKER_MATCH_TYPE.includes('Deposit'));
});
