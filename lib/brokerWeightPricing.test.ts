// BROKER RAIL — WEIGHT-PRICED (range) mode.
//
// A represented ranch that prices on HANGING WEIGHT ($/lb × carcass weight)
// cannot state an exact share price until the animal is processed. When a
// cut's `<Cut> Price Max` is set strictly above its `<Cut> Price`, the cut is
// WEIGHT-PRICED: the Price field is the range FLOOR, Max the ceiling, and
// every buyer/rancher surface states the honest estimated range instead of a
// false exact number.
//
// THE TWO NON-NEGOTIABLES PINNED HERE:
//   1. EXACT MODE IS BYTE-IDENTICAL — Max missing / ≤ floor collapses to the
//      pre-existing behavior (quote shape, metadata, idempotency key, emails).
//   2. THE DEPOSIT IS THE COMMISSION AND NEVER MOVES — range mode may not
//      alter deposit math, fee stamps, or settlement amounts in any way.
//
// All ranch names below are SYNTHETIC — the repo is PUBLIC.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertBrokerEligible,
  readBrokerMoney,
  brokerBalanceNote,
  brokerPricingNote,
  formatUsdCents,
  BROKER_PRICING_NOTE_FIELD,
  BROKER_BALANCE_NOTE_FALLBACK,
} from './brokerRail';
import {
  buildBrokerCheckoutMetadata,
  brokerCheckoutIdempotencyKey,
  createBrokerCheckout,
} from './brokerCheckout';
import { brokerReferralNotes } from './brokerReferral';
import {
  buildBrokerOrderFacts,
  buildBrokerRancherEmail,
  buildBrokerBuyerReceipt,
  buildBrokerOperatorCard,
  type BrokerOrderFacts,
} from './brokerNotify';

// A weight-priced broker ranch fixture shaped like the weight-priced ranch's
// live configuration (floors 1050/2025/4050, ceilings 1225/2363/4725, deposits
// 100/200/400) — numbers only, synthetic name (public repo).
function weightRancher(over: Record<string, any> = {}) {
  return {
    id: 'recBROKERWEIGHT1',
    'Ranch Name': 'Granite Hollow Beef',
    'Broker Rail': true,
    'Quarter Price': 1050,
    'Quarter Price Max': 1225,
    'Quarter Deposit': 100,
    'Half Price': 2025,
    'Half Price Max': 2363,
    'Half Deposit': 200,
    'Whole Price': 4050,
    'Whole Price Max': 4725,
    'Whole Deposit': 400,
    [BROKER_PRICING_NOTE_FIELD]:
      'Your share is priced per pound of hanging weight. Halves typically hang 350–410 lbs, so most halves land in the estimated range shown.',
    'Broker Balance Note': 'Cash or check at pickup.',
    ...over,
  };
}

/** An exact-mode broker ranch — no Max fields at all. */
function exactRancher(over: Record<string, any> = {}) {
  return {
    id: 'recBROKEREXACT01',
    'Ranch Name': 'Cedar Draw Beef',
    'Broker Rail': true,
    'Half Price': 1800,
    'Half Deposit': 400,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// THE QUOTE — range mode
// ---------------------------------------------------------------------------

test('RANGE quote: floor, ceiling, and the estimated balance at both ends', () => {
  const r = assertBrokerEligible(weightRancher(), 'half');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.quote.weightPriced, true);
  assert.equal(r.quote.priceCents, 202500); // the FLOOR
  assert.equal(r.quote.priceMaxCents, 236300); // the ceiling
  assert.equal(r.quote.depositCents, 20000); // EXACT — the commission
  assert.equal(r.quote.balanceCents, 182500); // floor − deposit
  assert.equal(r.quote.balanceMaxCents, 216300); // ceiling − deposit
});

test('RANGE quote: all three live-shaped cuts quote their own range', () => {
  const expected: Array<['quarter' | 'half' | 'whole', number, number, number]> = [
    ['quarter', 105000, 122500, 10000],
    ['half', 202500, 236300, 20000],
    ['whole', 405000, 472500, 40000],
  ];
  for (const [cut, floor, max, dep] of expected) {
    const r = assertBrokerEligible(weightRancher(), cut);
    assert.equal(r.ok, true, `cut ${cut} must be sellable`);
    if (!r.ok) continue;
    assert.equal(r.quote.weightPriced, true);
    assert.equal(r.quote.priceCents, floor);
    assert.equal(r.quote.priceMaxCents, max);
    assert.equal(r.quote.depositCents, dep);
    assert.equal(r.quote.balanceCents, floor - dep);
    assert.equal(r.quote.balanceMaxCents, max - dep);
  }
});

test('EXACT MODE PIN: no Max field yields the exact quote shape — no range keys at all', () => {
  const r = assertBrokerEligible(exactRancher(), 'half');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // deepEqual pins the SHAPE: a reader can never mistake a collapsed 0 for money.
  assert.deepEqual(r.quote, {
    cut: 'half',
    cutLabel: 'Half Cow',
    priceCents: 180000,
    depositCents: 40000,
    balanceCents: 140000,
    weightPriced: false,
  });
});

test('EXACT MODE PIN: Max EQUAL to the floor is exact mode (semantics: only Max > Price ranges)', () => {
  const r = assertBrokerEligible(exactRancher({ 'Half Price Max': 1800 }), 'half');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.quote.weightPriced, false);
  assert.equal(r.quote.priceMaxCents, undefined);
  assert.equal(r.quote.priceMaxIgnored, undefined); // ≤ floor is a config choice, not malformed
});

test('EXACT MODE PIN: Max BELOW the floor is exact mode, silently', () => {
  const r = assertBrokerEligible(exactRancher({ 'Half Price Max': 1500 }), 'half');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.quote.weightPriced, false);
  assert.equal(r.quote.priceMaxIgnored, undefined);
});

test('MALFORMED Max (garbage / negative) → treated as absent AND noted on the quote', () => {
  for (const bad of ['not a number', -500, 'NaN', {}]) {
    const r = assertBrokerEligible(exactRancher({ 'Half Price Max': bad }), 'half');
    assert.equal(r.ok, true, `malformed Max ${JSON.stringify(bad)} must not block the sale`);
    if (!r.ok) continue;
    assert.equal(r.quote.weightPriced, false);
    assert.equal(r.quote.priceMaxCents, undefined);
    assert.equal(r.quote.priceMaxIgnored, 'malformed', `Max ${JSON.stringify(bad)} must be noted`);
    // The money is byte-identical to the no-Max quote apart from the note.
    assert.equal(r.quote.priceCents, 180000);
    assert.equal(r.quote.depositCents, 40000);
  }
});

test('blank-string Max is simply absent — exact mode, no malformed note', () => {
  const r = assertBrokerEligible(exactRancher({ 'Half Price Max': '  ' }), 'half');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.quote.weightPriced, false);
  assert.equal(r.quote.priceMaxIgnored, undefined);
});

test('DEPOSIT GATE UNCHANGED: deposit ≥ the FLOOR is refused even with a ceiling above it', () => {
  // The ceiling can never rescue a deposit the floor refuses — the deposit is
  // the commission and the floor is the strictest truth we hold.
  const r = assertBrokerEligible(
    weightRancher({ 'Half Price': 2025, 'Half Deposit': 2025, 'Half Price Max': 2363 }),
    'half',
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'deposit_exceeds_price');

  const above = assertBrokerEligible(
    weightRancher({ 'Half Price': 2025, 'Half Deposit': 2100, 'Half Price Max': 2363 }),
    'half',
  );
  assert.equal(above.ok, false);
  assert.equal(above.ok === false && above.code, 'deposit_exceeds_price');
});

test('range detection cannot rescue an unsellable cut (unpriced / no deposit still refuse)', () => {
  const noDeposit = assertBrokerEligible(
    exactRancher({ 'Half Deposit': undefined, 'Half Price Max': 2363 }),
    'half',
  );
  assert.equal(noDeposit.ok, false);
  assert.equal(noDeposit.ok === false && noDeposit.code, 'no_deposit');

  const noPrice = assertBrokerEligible(
    exactRancher({ 'Half Price': undefined, 'Half Price Max': 2363 }),
    'half',
  );
  assert.equal(noPrice.ok, false);
  assert.equal(noPrice.ok === false && noPrice.code, 'cut_unpriced');
});

// ---------------------------------------------------------------------------
// COMMISSION INVARIANCE — the deposit never moves
// ---------------------------------------------------------------------------

test('COMMISSION INVARIANCE: the quote deposit is identical in range and exact mode', () => {
  const exact = assertBrokerEligible(exactRancher({ 'Half Price': 2025, 'Half Deposit': 200 }), 'half');
  const ranged = assertBrokerEligible(weightRancher(), 'half');
  assert.ok(exact.ok && ranged.ok);
  if (!exact.ok || !ranged.ok) return;
  assert.equal(exact.quote.depositCents, ranged.quote.depositCents);
  assert.equal(ranged.quote.depositCents, 20000);
});

// ---------------------------------------------------------------------------
// STRIPE METADATA + IDEMPOTENCY — the settlement contract
// ---------------------------------------------------------------------------

const checkoutBase = {
  depositCents: 20000,
  priceCents: 202500,
  cut: 'half' as const,
  referralId: 'recREF0000000001',
  buyerId: 'recBUYER00000001',
  rancherId: 'recBROKERWEIGHT1',
};

test('EXACT metadata is byte-identical to before range mode existed', () => {
  const meta = buildBrokerCheckoutMetadata(checkoutBase);
  assert.deepEqual(meta, {
    type: 'broker_deposit',
    rail: 'broker',
    referralId: 'recREF0000000001',
    buyerId: 'recBUYER00000001',
    rancherId: 'recBROKERWEIGHT1',
    cut: 'half',
    depositCents: '20000',
    brokerCommissionCents: '20000',
    priceCents: '202500',
    balanceDueRancherCents: '182500',
  });
});

test('RANGE metadata adds the ceiling and keeps priceCents as the FLOOR', () => {
  const meta = buildBrokerCheckoutMetadata({ ...checkoutBase, priceMaxCents: 236300 });
  assert.equal(meta.priceCents, '202500'); // the FLOOR — Total Sale Amount stamps from this
  assert.equal(meta.weightPriced, 'true');
  assert.equal(meta.priceMaxCents, '236300');
  assert.equal(meta.balanceDueRancherMaxCents, '216300');
});

test('SETTLEMENT-MONEY PIN: deposit + commission metadata identical in range vs exact mode', () => {
  const exact = buildBrokerCheckoutMetadata(checkoutBase);
  const ranged = buildBrokerCheckoutMetadata({ ...checkoutBase, priceMaxCents: 236300 });
  // The fee stamps (`BHC Fee Cents` = deposit) and the Payments ledger both
  // read these two keys — they must be indistinguishable across modes.
  assert.equal(exact.depositCents, ranged.depositCents);
  assert.equal(exact.brokerCommissionCents, ranged.brokerCommissionCents);
  assert.equal(exact.type, ranged.type);
  assert.equal(exact.rail, ranged.rail);
});

test('idempotency key: exact unchanged; range folds the ceiling in', () => {
  assert.equal(
    brokerCheckoutIdempotencyKey(checkoutBase),
    'broker-recREF0000000001-20000-202500-v1',
  );
  assert.equal(
    brokerCheckoutIdempotencyKey({ ...checkoutBase, priceMaxCents: 236300 }),
    'broker-recREF0000000001-20000-202500-max236300-v1',
  );
});

test('createBrokerCheckout REFUSES a present-but-invalid ceiling (fail closed, before Stripe)', async () => {
  await assert.rejects(
    createBrokerCheckout({
      ...checkoutBase,
      priceMaxCents: 202500, // == floor: not a range
      buyerEmail: 'buyer@example.test',
      productLabel: 'Half Cow — Granite Hollow Beef',
      successUrl: 'https://example.test/s',
      cancelUrl: 'https://example.test/c',
    }),
    /priceMaxCents > priceCents/,
  );
});

// ---------------------------------------------------------------------------
// readBrokerMoney — settlement's money read
// ---------------------------------------------------------------------------

test('readBrokerMoney: range metadata yields the range; priceCents stays the FLOOR', () => {
  const m = readBrokerMoney({
    amount: 20000,
    metadata: { depositCents: '20000', priceCents: '202500', priceMaxCents: '236300' },
  });
  assert.equal(m.depositCents, 20000);
  assert.equal(m.priceCents, 202500); // FLOOR → Total Sale Amount stamp
  assert.equal(m.balanceCents, 182500);
  assert.equal(m.weightPriced, true);
  assert.equal(m.priceMaxCents, 236300);
  assert.equal(m.balanceMaxCents, 216300);
});

test('readBrokerMoney: no ceiling collapses to the exact price (weightPriced=false)', () => {
  const m = readBrokerMoney({
    amount: 20000,
    metadata: { depositCents: '20000', priceCents: '202500' },
  });
  assert.equal(m.weightPriced, false);
  assert.equal(m.priceMaxCents, m.priceCents);
  assert.equal(m.balanceMaxCents, m.balanceCents);
});

test('readBrokerMoney: malformed / not-above-floor ceiling collapses, never a nonsense range', () => {
  for (const bad of ['garbage', '0', '-5', '202500', '100']) {
    const m = readBrokerMoney({
      amount: 20000,
      metadata: { depositCents: '20000', priceCents: '202500', priceMaxCents: bad },
    });
    assert.equal(m.weightPriced, false, `ceiling ${bad} must collapse`);
    assert.equal(m.priceMaxCents, 202500);
  }
});

test('SETTLEMENT-MONEY PIN: readBrokerMoney deposit identical with and without a ceiling', () => {
  const exact = readBrokerMoney({ amount: 20000, metadata: { depositCents: '20000', priceCents: '202500' } });
  const ranged = readBrokerMoney({
    amount: 20000,
    metadata: { depositCents: '20000', priceCents: '202500', priceMaxCents: '236300' },
  });
  // `BHC Fee Cents` / markDepositSucceeded totalChargedCents both come from
  // depositCents — the commission is untouched by range mode.
  assert.equal(exact.depositCents, ranged.depositCents);
  assert.equal(exact.priceCents, ranged.priceCents);
});

// ---------------------------------------------------------------------------
// Balance-note composition + pricing note
// ---------------------------------------------------------------------------

test('brokerBalanceNote LEADS with the range when weight-priced', () => {
  const note = brokerBalanceNote(weightRancher(), { balanceCents: 182500, balanceMaxCents: 216300 });
  assert.ok(
    note.startsWith(
      'Your final share price is set by hanging weight, so the balance you pay the ranch will land between $1,825 and $2,163.',
    ),
    `note must LEAD with the range, got: ${note}`,
  );
  assert.ok(note.endsWith('Cash or check at pickup.'), 'the ranch’s own instruction still follows');
});

test('brokerBalanceNote: no range argument is byte-identical to before (exact-mode pin)', () => {
  assert.equal(brokerBalanceNote(weightRancher()), 'Cash or check at pickup.');
  assert.equal(brokerBalanceNote({}), BROKER_BALANCE_NOTE_FALLBACK);
  // A degenerate range (max ≤ min) collapses to the plain note — never a lie.
  assert.equal(
    brokerBalanceNote(weightRancher(), { balanceCents: 182500, balanceMaxCents: 182500 }),
    'Cash or check at pickup.',
  );
});

test('brokerPricingNote: reads + trims the field, "" when unset', () => {
  assert.ok(brokerPricingNote(weightRancher()).startsWith('Your share is priced per pound'));
  assert.equal(brokerPricingNote({}), '');
  assert.equal(brokerPricingNote({ [BROKER_PRICING_NOTE_FIELD]: '   ' }), '');
});

test('formatUsdCents: whole dollars stay whole, real cents keep two places', () => {
  assert.equal(formatUsdCents(105000), '$1,050');
  assert.equal(formatUsdCents(216300), '$2,163');
  assert.equal(formatUsdCents(179999), '$1,799.99');
  assert.equal(formatUsdCents(NaN as any), '$0');
});

// ---------------------------------------------------------------------------
// Referral Notes — the range + flag recorded on the row
// ---------------------------------------------------------------------------

test('brokerReferralNotes: exact mode is byte-identical to the pre-existing note', () => {
  const g = assertBrokerEligible(exactRancher(), 'half');
  assert.ok(g.ok);
  if (!g.ok) return;
  assert.equal(
    brokerReferralNotes(g.quote),
    '[Source] Broker rail — BHC represents this ranch; the deposit is BHC commission and the rancher collects the balance direct.',
  );
});

test('brokerReferralNotes: weight-priced rows record the range + the floor-stamp semantics', () => {
  const g = assertBrokerEligible(weightRancher(), 'quarter');
  assert.ok(g.ok);
  if (!g.ok) return;
  const notes = brokerReferralNotes(g.quote);
  assert.ok(notes.includes('[weight-priced]'));
  assert.ok(notes.includes('hanging weight'));
  assert.ok(notes.includes('$1,050–$1,225'));
  assert.ok(notes.includes('Total Sale Amount is stamped at the range FLOOR'));
});

// ---------------------------------------------------------------------------
// THE EMAILS — range framing, and never a false exact number
// ---------------------------------------------------------------------------

/** Facts as settlement would build them for the live-shaped half. */
function rangedFacts(): BrokerOrderFacts {
  return buildBrokerOrderFacts({
    rancher: weightRancher({ Email: 'ranch@example.test', Phone: '(406) 555-0100' }),
    referral: { 'Buyer Name': 'Jordan Blake', 'Buyer Email': 'jordan@example.test' },
    consumer: { State: 'MT', Zip: '59718' },
    cutLabel: 'Half Cow',
    priceCents: 202500,
    depositCents: 20000,
    priceMaxCents: 236300,
    orderRef: 'BHC-abc123',
  });
}

test('buildBrokerOrderFacts: carries the range, the composed balance note, and the pricing note', () => {
  const f = rangedFacts();
  assert.equal(f.weightPriced, true);
  assert.equal(f.priceMaxCents, 236300);
  assert.equal(f.balanceCents, 182500);
  assert.equal(f.balanceMaxCents, 216300);
  assert.ok(f.balanceNote.startsWith('Your final share price is set by hanging weight'));
  assert.ok((f.pricingNote || '').includes('hanging weight'));
});

test('buildBrokerOrderFacts: an absent / not-above-floor ceiling collapses to exact framing', () => {
  const f = buildBrokerOrderFacts({
    rancher: exactRancher(),
    referral: {},
    cutLabel: 'Half Cow',
    priceCents: 180000,
    depositCents: 40000,
    orderRef: 'x',
  });
  assert.equal(f.weightPriced, false);
  assert.equal(f.priceMaxCents, f.priceCents);
  assert.equal(f.balanceMaxCents, f.balanceCents);

  const collapsed = buildBrokerOrderFacts({
    rancher: exactRancher(),
    referral: {},
    cutLabel: 'Half Cow',
    priceCents: 180000,
    depositCents: 40000,
    priceMaxCents: 180000, // == price: not a range
    orderRef: 'x',
  });
  assert.equal(collapsed.weightPriced, false);
});

test('RANCHER email (range): deposit exact, balance as the range, exact balance NEVER stated', () => {
  const built = buildBrokerRancherEmail(rangedFacts());
  // Subject leads with the collect RANGE.
  assert.ok(built.subject.includes('$1,825.00–$2,163.00 to collect'));
  for (const body of [built.html, built.text]) {
    assert.ok(body.includes('$2,025.00–$2,363.00'), 'share price range must render');
    assert.ok(body.includes('$1,825.00–$2,163.00'), 'collect range must render');
    assert.ok(body.includes('$200.00'), 'the exact deposit must render');
    assert.ok(/set by hanging weight/i.test(body), 'must say the balance is set by hanging weight');
  }
  // The exact-mode sentences must be GONE — no false exact balance anywhere.
  assert.ok(!built.html.includes('<strong>$1,825.00</strong>'), 'no exact net figure');
  assert.ok(!built.html.includes('full share price'), 'no "full share price" label in range mode');
  assert.ok(!built.html.includes('Collect the $'), 'no exact collect instruction');
  assert.ok(!built.text.includes('YOU COLLECT FROM THE BUYER: $1,825.00\n'), 'no exact collect line');
  // The commission truths still stand, verbatim class.
  const lower = built.html.toLowerCase();
  assert.ok(lower.includes("buyhalfcow's commission"));
  assert.ok(lower.includes('we keep it'));
  assert.ok(lower.includes('do not invoice you'));
});

test('RANCHER email (range): echoes the pricing basis the buyer was shown', () => {
  const built = buildBrokerRancherEmail(rangedFacts());
  assert.ok(built.html.includes('Pricing basis (what the buyer was shown)'));
  assert.ok(built.html.includes('priced per pound of hanging weight'));
  assert.ok(built.text.includes('PRICING BASIS (what the buyer was shown)'));
});

test('BUYER receipt (range): estimated framing + the note, and NEVER an exact balance', () => {
  const built = buildBrokerBuyerReceipt(rangedFacts());
  assert.ok(built.html.includes('Estimated price for your share'));
  assert.ok(built.html.includes('$2,025.00–$2,363.00'));
  assert.ok(built.html.includes('Estimated balance due to the ranch'));
  assert.ok(built.html.includes('$1,825.00–$2,163.00'));
  assert.ok(built.html.includes('How your final price is set'));
  assert.ok(built.html.includes('priced per pound of hanging weight'));
  // The exact-mode money statements are GONE.
  assert.ok(!built.html.includes('<td class="balance">Balance due to the ranch</td>'));
  assert.ok(!built.html.includes('Total price for your share'));
  assert.ok(!built.html.includes('The remaining <strong>$1,825.00</strong>'));
  // Text mirror.
  assert.ok(built.text.includes('ESTIMATED BALANCE DUE TO THE RANCH: $1,825.00–$2,163.00'));
  assert.ok(!built.text.includes('BALANCE DUE TO THE RANCH: $1,825.00\n'));
  assert.ok(built.text.includes('HOW YOUR FINAL PRICE IS SET'));
  // The deposit line stays exact — it is unaffected by the weight.
  assert.ok(built.html.includes('$200.00'));
});

test('BUYER receipt (range): the split stays SILENT — forbidden words pin holds with range copy', () => {
  const built = buildBrokerBuyerReceipt(rangedFacts());
  const all = `${built.html} ${built.text} ${built.subject}`.toLowerCase();
  for (const forbidden of ['commission', 'we keep', 'our fee', 'service fee', 'brokerage']) {
    assert.ok(!all.includes(forbidden), `buyer receipt (range) must not mention "${forbidden}"`);
  }
});

test('BUYER receipt (range): balance note LEADS with the range on the receipt too', () => {
  const built = buildBrokerBuyerReceipt(rangedFacts());
  assert.ok(
    built.html.includes(
      'Your final share price is set by hanging weight, so the balance you pay the ranch will land between $1,825 and $2,163.',
    ),
  );
});

test('BUYER receipt (range): third-party cost copy cites no exact balance', () => {
  const f = buildBrokerOrderFacts({
    rancher: weightRancher({ 'Broker Additional Costs': 'Cut and wrap is billed by the butcher.' }),
    referral: {},
    cutLabel: 'Half Cow',
    priceCents: 202500,
    depositCents: 20000,
    priceMaxCents: 236300,
    orderRef: 'x',
  });
  const built = buildBrokerBuyerReceipt(f);
  assert.ok(built.html.includes('separate from your $200.00 deposit and from the balance you pay'));
  assert.ok(!built.html.includes('$1,825.00 balance you pay'));
});

test('operator card (range): exact commission, ranged price + collect', () => {
  const card = buildBrokerOperatorCard(rangedFacts());
  assert.ok(card.includes('BHC commission (deposit, kept in full): $200.00'));
  assert.ok(card.includes('Share price: $2,025.00–$2,363.00 (hanging weight)'));
  assert.ok(card.includes('Rancher collects direct: $1,825.00–$2,163.00'));
});

// ---------------------------------------------------------------------------
// EXACT-MODE BYTE-IDENTITY — pre-range facts and collapsed facts render the
// same bytes, so no exact-mode email changed under this feature.
// ---------------------------------------------------------------------------

test('EXACT emails are byte-identical whether the range fields are absent or collapsed', () => {
  const legacyShape: BrokerOrderFacts = {
    ranchName: 'Cedar Draw Beef',
    operatorName: 'Sam Rivers',
    rancherEmail: 'sam@example.test',
    rancherPhone: '(406) 555-0142',
    buyerName: 'Jordan Blake',
    buyerEmail: 'jordan@example.test',
    buyerPhone: '(512) 555-0199',
    fulfillmentPref: 'pickup',
    buyerState: 'TX',
    buyerZip: '78704',
    cutLabel: 'Half Cow',
    priceCents: 180000,
    depositCents: 40000,
    balanceCents: 140000,
    balanceNote: 'Cash or check at pickup.',
    fulfillmentSteps: [],
    additionalCosts: '',
    orderRef: 'BHC-abc123',
  };
  const collapsed: BrokerOrderFacts = {
    ...legacyShape,
    weightPriced: false,
    priceMaxCents: 180000,
    balanceMaxCents: 140000,
    pricingNote: 'A pricing note that must NOT render in exact mode.',
  };
  assert.deepEqual(buildBrokerRancherEmail(collapsed), buildBrokerRancherEmail(legacyShape));
  assert.deepEqual(buildBrokerBuyerReceipt(collapsed), buildBrokerBuyerReceipt(legacyShape));
  assert.equal(buildBrokerOperatorCard(collapsed), buildBrokerOperatorCard(legacyShape));
});
