// lib/depositResolve.test.ts
//
// P0 (2026-08-18) — THE DEPOSIT PAGE DISPLAYED A DIFFERENT AMOUNT THAN THE CARD
// WAS CHARGED. The charge path honored a rancher's custom deposit quote on the
// referral; the GET that RENDERS the page never read the referral for money at
// all and quoted the rancher's per-cut default. Silverline Quarter: page said
// $695.00, card was hit for $795.00 (+$100, +14.4%). Five live payable
// referrals sat in that state while an hourly nudge cron drove buyers at the
// page. The last screen before the card is the one surface that may never lie.
//
// WHAT THESE TESTS PIN (in order of how much they matter):
//
//   1. DISPLAY === CHARGE, to the cent, on every branch. The charge total is
//      re-derived here from the Stripe call's own arithmetic
//      (lib/stripeConnect.createDepositCheckout: unit_amount = amountCents +
//      round(fullSaleCents × commissionRate)) rather than read back off the
//      helper, so this is a real comparison and not a tautology.
//   2. The PRECEDENCE ladder, re-implemented independently below
//      (expectedDepositDollars) as a hand-written spec the resolver must match.
//   3. Both route paths actually CALL the resolver — a shared helper nothing
//      calls fixes nothing. Source pins at the bottom, and they are what fails
//      if the GET is ever reverted to the stored-deposit-only path.
//   4. The BROKER rail is untouched: flat deposit that IS the commission,
//      nothing added on top, never derived. Different money model, different
//      module (lib/brokerRail), and it must stay that way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  resolveDepositDollars,
  resolveDepositMoney,
  referralQuotesCut,
  CUT_PRICE_FIELD,
  CUT_DEPOSIT_FIELD,
  type DepositCut,
} from './depositResolve';
import { deriveDeposit } from './pricing';
import { assertBrokerEligible } from './brokerRail';
import { TIERS } from './tiers';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/**
 * Source with comments stripped. The route files carry long incident write-ups
 * that NAME the functions they must no longer call ("this used to call
 * depositDisplay…"), and that history is worth keeping — so the code pins below
 * read code only. Conservative on purpose: block comments, and whole lines that
 * are comments. Trailing `//` after code is left alone rather than risk eating
 * a `https://` inside a string literal.
 */
const readCode = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// Independent re-implementations of the two sides. Neither calls the module
// under test; that is the entire point.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE CHARGE, re-derived from lib/stripeConnect.createDepositCheckout:
 *     totalChargedCents = amountCents + round(fullSaleCents × commissionRate)
 * and that total is what Stripe's line item `unit_amount` is set to — the
 * literal number that hits the buyer's card. absorbStripeFee moves the
 * platform/rancher split only and never touches this total.
 */
function chargedTotalCents(depositDollars: number, priceDollars: number, rate: number): number {
  const fullSaleCents = Math.round(priceDollars * 100);
  const amountCents = Math.round(depositDollars * 100);
  return amountCents + Math.round(fullSaleCents * rate);
}

/** The precedence ladder, written out longhand as the spec the resolver must meet. */
function expectedDepositDollars(referral: any, rancher: any, cut: DepositCut): number {
  const price = Number(rancher[CUT_PRICE_FIELD[cut]]);
  const quote = Number(referral?.['Deposit Amount']);
  const orderTypeMatches =
    String(referral?.['Order Type'] ?? '').trim().toLowerCase() === cut;
  const asked = String(referral?.['Deposit Requested At'] ?? '').trim() !== '';
  if (orderTypeMatches && asked && Number.isFinite(quote) && quote > 0 && quote <= price) {
    return quote;
  }
  const stored = Number(rancher[CUT_DEPOSIT_FIELD[cut]]);
  if (Number.isFinite(stored) && stored > 0 && stored <= price) return stored;
  return deriveDeposit(price);
}

/** The OLD, broken GET: stored per-cut deposit only, referral never consulted. */
function preFixDisplayedDueNowCents(rancher: any, cut: DepositCut, rate: number): number {
  const price = Number(rancher[CUT_PRICE_FIELD[cut]]);
  const stored = Number(rancher[CUT_DEPOSIT_FIELD[cut]]);
  const dep = Number.isFinite(stored) && stored > 0 && stored <= price ? stored : deriveDeposit(price);
  return chargedTotalCents(dep, price, rate);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The live incident, pinned exactly.
// ─────────────────────────────────────────────────────────────────────────────

// Silverline (Quarter): price $1,950 · stored per-cut deposit $500 · rancher
// quoted $600 on the referral · locked commission rate 10%.
const SILVERLINE_RANCHER = {
  'Quarter Price': 1950,
  'Quarter Deposit': 500,
  'Commission Rate': 0.1,
};
const SILVERLINE_REFERRAL = {
  'Order Type': 'Quarter',              // request-deposit stamps title case
  'Deposit Amount': 600,                // the rancher's custom ask
  'Deposit Requested At': '2026-08-17T15:44:00.000Z',
};
const SILVERLINE_RATE = 0.1;

test('SILVERLINE P0: the page and the card both say $795.00', () => {
  const m = resolveDepositMoney(SILVERLINE_REFERRAL, SILVERLINE_RANCHER, 'quarter', SILVERLINE_RATE);
  assert.ok(m);
  // Rendered "due today" — what the buyer reads on the last screen.
  assert.equal(m!.dueNowCents, 79500, 'deposit page must render $795.00');
  // Charged — re-derived from the Stripe line item's own arithmetic.
  assert.equal(
    chargedTotalCents(m!.depositDollars, 1950, SILVERLINE_RATE),
    79500,
    'card must be charged $795.00',
  );
  assert.equal(m!.dueNowCents, chargedTotalCents(m!.depositDollars, 1950, SILVERLINE_RATE));
  // The quote is what won, not the stored $500 default.
  assert.equal(m!.source, 'rancher-quote');
  assert.equal(m!.depositCents, 60000);
  assert.equal(m!.feeCents, 19500);      // round(195000 × 0.10)
  assert.equal(m!.balanceCents, 135000); // $1,950 − $600, paid rancher-direct
});

test('SILVERLINE P0: the pre-fix GET rendered $695.00 — the exact lie, +$100 / +14.4%', () => {
  // This is the defect reproduced, so the pin above cannot be read as "some
  // number came out". Kept as a regression witness: if the GET ever goes back
  // to stored-deposit-only, this is the number buyers would see again.
  const lied = preFixDisplayedDueNowCents(SILVERLINE_RANCHER, 'quarter', SILVERLINE_RATE);
  assert.equal(lied, 69500);
  const truth = resolveDepositMoney(SILVERLINE_REFERRAL, SILVERLINE_RANCHER, 'quarter', SILVERLINE_RATE)!.dueNowCents;
  assert.equal(truth - lied, 10000, 'the gap was exactly $100');
  assert.ok(Math.abs((truth - lied) / lied - 0.1439) < 0.001, 'the gap was ~14.4% of the displayed number');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Display === charge on EVERY branch, at EVERY rate.
// ─────────────────────────────────────────────────────────────────────────────

// Every rate the platform can actually apply: each tier constant (Operator is a
// genuine 0 — a locked/negotiated zero must produce a $0 fee, never a default),
// the legacy 10%, a locked half-percent, and 0 again explicitly.
const RATES = [
  ...Object.values(TIERS).map((t) => t.commissionRate), // 0.07, 0.03, 0, 0.10
  0,
  0.035,
  0.1,
];

const BRANCHES: Array<{ name: string; referral: any; rancher: any; cut: DepositCut; expectSource: 'rancher-quote' | 'stored' | 'derived' }> = [
  {
    name: 'quote present for this cut',
    referral: { 'Order Type': 'Half', 'Deposit Amount': 750, 'Deposit Requested At': '2026-08-17T00:00:00Z' },
    rancher: { 'Half Price': 2600, 'Half Deposit': 650 },
    cut: 'half',
    expectSource: 'rancher-quote',
  },
  {
    name: 'quote is for a DIFFERENT cut (buyer switched to whole)',
    referral: { 'Order Type': 'Quarter', 'Deposit Amount': 600, 'Deposit Requested At': '2026-08-17T00:00:00Z' },
    rancher: { 'Whole Price': 3400, 'Whole Deposit': 850, 'Quarter Price': 1950, 'Quarter Deposit': 500 },
    cut: 'whole',
    expectSource: 'stored',
  },
  {
    name: 'quote present but Deposit Requested At is BLANK (residue, not an ask)',
    referral: { 'Order Type': 'Quarter', 'Deposit Amount': 600, 'Deposit Requested At': '' },
    rancher: { 'Quarter Price': 1950, 'Quarter Deposit': 500 },
    cut: 'quarter',
    expectSource: 'stored',
  },
  {
    name: 'quote present, Deposit Requested At missing entirely',
    referral: { 'Order Type': 'Quarter', 'Deposit Amount': 600 },
    rancher: { 'Quarter Price': 1950, 'Quarter Deposit': 500 },
    cut: 'quarter',
    expectSource: 'stored',
  },
  {
    name: 'no quote at all, stored per-cut deposit set',
    referral: {},
    rancher: { 'Quarter Price': 1950, 'Quarter Deposit': 500 },
    cut: 'quarter',
    expectSource: 'stored',
  },
  {
    name: 'no quote, no stored deposit — derived reserve',
    referral: {},
    rancher: { 'Half Price': 2200 },
    cut: 'half',
    expectSource: 'derived',
  },
  {
    name: 'quote ABOVE the full price falls through (balance would go negative)',
    referral: { 'Order Type': 'Quarter', 'Deposit Amount': 2500, 'Deposit Requested At': '2026-08-17T00:00:00Z' },
    rancher: { 'Quarter Price': 1950, 'Quarter Deposit': 500 },
    cut: 'quarter',
    expectSource: 'stored',
  },
  {
    name: 'quote EQUAL to the full price is honored (the boundary is inclusive)',
    referral: { 'Order Type': 'Quarter', 'Deposit Amount': 1950, 'Deposit Requested At': '2026-08-17T00:00:00Z' },
    rancher: { 'Quarter Price': 1950, 'Quarter Deposit': 500 },
    cut: 'quarter',
    expectSource: 'rancher-quote',
  },
  {
    name: 'zero / negative / NaN quote falls through',
    referral: { 'Order Type': 'Quarter', 'Deposit Amount': 0, 'Deposit Requested At': '2026-08-17T00:00:00Z' },
    rancher: { 'Quarter Price': 1950, 'Quarter Deposit': 500 },
    cut: 'quarter',
    expectSource: 'stored',
  },
  {
    name: 'quote honored even when the stored deposit is junk',
    referral: { 'Order Type': 'Whole', 'Deposit Amount': 900, 'Deposit Requested At': '2026-08-17T00:00:00Z' },
    rancher: { 'Whole Price': 3400, 'Whole Deposit': 99999 },
    cut: 'whole',
    expectSource: 'rancher-quote',
  },
  {
    name: 'cents-bearing price pins the rounding ORDER (cents first, then rate)',
    referral: { 'Order Type': 'Half', 'Deposit Amount': 617.5, 'Deposit Requested At': '2026-08-17T00:00:00Z' },
    rancher: { 'Half Price': 1234.56, 'Half Deposit': 300 },
    cut: 'half',
    expectSource: 'rancher-quote',
  },
];

for (const b of BRANCHES) {
  for (const rate of RATES) {
    test(`display === charge to the cent — ${b.name} @ rate ${rate}`, () => {
      const m = resolveDepositMoney(b.referral, b.rancher, b.cut, rate);
      assert.ok(m, 'branch must produce money');
      const price = Number(b.rancher[CUT_PRICE_FIELD[b.cut]]);

      // The precedence spec, independently written.
      const expectedDeposit = expectedDepositDollars(b.referral, b.rancher, b.cut);
      assert.equal(m!.depositDollars, expectedDeposit, 'resolver must follow the precedence ladder');
      assert.equal(m!.source, b.expectSource);

      // THE PIN: what the page renders === what the card is charged.
      assert.equal(
        m!.dueNowCents,
        chargedTotalCents(expectedDeposit, price, rate),
        'displayed dueNowCents must equal the Stripe unit_amount to the cent',
      );

      // Shape invariants that make the number honest.
      assert.equal(m!.dueNowCents, m!.depositCents + m!.feeCents);
      assert.equal(m!.balanceCents, m!.fullCents - m!.depositCents);
      assert.equal(m!.feeCents, Math.round(Math.round(price * 100) * rate));
      assert.ok(m!.depositCents > 0, 'the buyer always pays a real deposit');
      assert.ok(m!.balanceCents >= 0, 'the balance at pickup is never negative');
      if (rate === 0) {
        assert.equal(m!.feeCents, 0, 'a zero rate adds nothing on top');
        assert.equal(m!.dueNowCents, m!.depositCents);
      }
    });
  }
}

test('a rancher quote changes the number on BOTH sides or neither', () => {
  // Sweep the same rancher with and without a live quote. Whatever the page
  // shows, the card matches — that is the property, not any single value.
  const rancher = { 'Quarter Price': 1950, 'Quarter Deposit': 500 };
  for (const quote of [null, 250, 600, 1200, 1950]) {
    for (const rate of RATES) {
      const referral = quote === null
        ? {}
        : { 'Order Type': 'Quarter', 'Deposit Amount': quote, 'Deposit Requested At': '2026-08-17T00:00:00Z' };
      const m = resolveDepositMoney(referral, rancher, 'quarter', rate)!;
      const expected = quote === null ? 500 : quote;
      assert.equal(m.depositDollars, expected, `quote=${quote}`);
      assert.equal(m.dueNowCents, chargedTotalCents(expected, 1950, rate), `quote=${quote} rate=${rate}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Resolver edge cases.
// ─────────────────────────────────────────────────────────────────────────────

test('referralQuotesCut requires BOTH a matching Order Type and the request stamp', () => {
  const stamped = '2026-08-17T00:00:00Z';
  assert.equal(referralQuotesCut({ 'Order Type': 'Quarter', 'Deposit Requested At': stamped }, 'quarter'), true);
  assert.equal(referralQuotesCut({ 'Order Type': 'quarter', 'Deposit Requested At': stamped }, 'quarter'), true);
  assert.equal(referralQuotesCut({ 'Order Type': ' Half ', 'Deposit Requested At': stamped }, 'half'), true);
  assert.equal(referralQuotesCut({ 'Order Type': 'Quarter', 'Deposit Requested At': '' }, 'quarter'), false);
  assert.equal(referralQuotesCut({ 'Order Type': 'Quarter' }, 'quarter'), false);
  assert.equal(referralQuotesCut({ 'Order Type': 'Half', 'Deposit Requested At': stamped }, 'quarter'), false);
  // 'Quarter Cow' (the broker route's cut label) is NOT a Connect quote match.
  assert.equal(referralQuotesCut({ 'Order Type': 'Quarter Cow', 'Deposit Requested At': stamped }, 'quarter'), false);
  assert.equal(referralQuotesCut({}, 'whole'), false);
  assert.equal(referralQuotesCut(null, 'whole'), false);
});

test('an unpriced cut resolves to null rather than a guessed amount', () => {
  assert.equal(resolveDepositDollars({}, { 'Half Price': 0 }, 'half'), null);
  assert.equal(resolveDepositDollars({}, {}, 'half'), null);
  assert.equal(resolveDepositDollars({}, { 'Half Price': -100 }, 'half'), null);
  assert.equal(resolveDepositDollars({}, { 'Half Price': 'nope' }, 'half'), null);
  assert.equal(resolveDepositMoney({}, { 'Half Price': 0 }, 'half', 0.07), null);
  // A live quote does NOT rescue an unpriced cut — there is nothing to bound it against.
  assert.equal(
    resolveDepositMoney(
      { 'Order Type': 'Half', 'Deposit Amount': 500, 'Deposit Requested At': '2026-08-17T00:00:00Z' },
      { 'Half Price': 0 },
      'half',
      0.07,
    ),
    null,
  );
});

test('a null/undefined referral is treated as no quote, never as a crash', () => {
  // The GET builds all three cuts from one referral; a stripped field must
  // degrade to the stored/derived rung, not throw on the money path.
  for (const ref of [null, undefined, {}, { 'Deposit Amount': 600 }]) {
    const m = resolveDepositMoney(ref, { 'Quarter Price': 1950, 'Quarter Deposit': 500 }, 'quarter', 0.1);
    assert.ok(m);
    assert.equal(m!.depositDollars, 500);
    assert.equal(m!.source, 'stored');
  }
});

test('derived rung stays a real partial: deposit < price for every chargeable price', () => {
  for (let p = 100; p <= 4000; p += 50) {
    const m = resolveDepositMoney({}, { 'Whole Price': p }, 'whole', 0.07)!;
    assert.equal(m.source, 'derived');
    assert.ok(m.depositCents > 0, `price ${p}`);
    assert.ok(m.depositCents < m.fullCents, `price ${p}: deposit must stay below price`);
    assert.ok(m.balanceCents > 0, `price ${p}: a real balance must remain`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The BROKER rail is a different money model and must stay untouched.
// ─────────────────────────────────────────────────────────────────────────────

test('BROKER: deposit is flat, exact, never derived, and nothing is added on top', () => {
  const brokerRancher = {
    'Broker Rail': true,
    'Half Price': 2600,
    'Half Deposit': 400,
  };
  const g = assertBrokerEligible(brokerRancher, 'half');
  assert.ok(g.ok, 'broker cut must be sellable');
  if (!g.ok) return;
  // The buyer pays the deposit and ONLY the deposit — no commission on top.
  assert.equal(g.quote.depositCents, 40000);
  assert.equal(g.quote.priceCents, 260000);
  assert.equal(g.quote.balanceCents, 220000);
  // And a broker cut with no explicit deposit is REFUSED, never derived —
  // deriving here would invent BHC's own commission.
  const noDeposit = assertBrokerEligible({ 'Broker Rail': true, 'Half Price': 2600 }, 'half');
  assert.equal(noDeposit.ok, false);
  if (!noDeposit.ok) assert.notEqual(noDeposit.code, undefined);
});

test('BROKER: the broker checkout route does not import the Connect deposit resolver', () => {
  const src = readCode('../app/api/checkout/broker/route.ts');
  assert.ok(
    !/from ['"]@\/lib\/depositResolve['"]/.test(src),
    'broker checkout must keep its own money model (lib/brokerRail), not the Connect resolver',
  );
});

test('BROKER: the Connect deposit route still refuses broker + ambiguous rails on BOTH verbs', () => {
  const src = readCode('../app/api/checkout/deposit/route.ts');
  const getAt = src.indexOf('export async function GET');
  assert.ok(getAt > 0, 'GET handler must exist');
  const post = src.slice(0, getAt);
  const get = src.slice(getAt);
  for (const [name, section] of [['POST', post], ['GET', get]] as const) {
    assert.match(section, /referralRailForRancher\(/, `${name} must classify the rail`);
    assert.match(section, /'ambiguous'/, `${name} must refuse an ambiguous rail`);
    assert.match(section, /not_connect_rail/, `${name} must redirect a broker rail`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Source pins — a shared resolver nothing calls fixes nothing.
//    These are the tests that fail if the GET is reverted to the old
//    stored-deposit-only path (the mutation test for this P0).
// ─────────────────────────────────────────────────────────────────────────────

test('BOTH deposit-route paths resolve money through lib/depositResolve', () => {
  const src = readCode('../app/api/checkout/deposit/route.ts');
  const getAt = src.indexOf('export async function GET');
  assert.ok(getAt > 0);
  const post = src.slice(0, getAt);
  const get = src.slice(getAt);

  assert.match(src, /from ['"]@\/lib\/depositResolve['"]/, 'route must import the shared resolver');

  // The CHARGE path.
  assert.match(post, /resolveDepositMoney\(\s*referral,\s*rancher,/,
    'POST must resolve the charge through resolveDepositMoney(referral, rancher, …)');
  // The RENDER path — and it MUST pass the referral. Passing the rancher alone
  // is exactly the pre-fix bug: the rancher record does not know what the
  // rancher quoted this buyer.
  assert.match(get, /resolveDepositMoney\(\s*referral,\s*rancher,/,
    'GET buildCut must resolve the display through resolveDepositMoney(referral, rancher, …) — the referral is money input on this surface');
});

test('neither deposit-route path computes a deposit any other way', () => {
  const src = readCode('../app/api/checkout/deposit/route.ts');
  // depositDisplay ignores the referral by construction, so it can never be the
  // render path's source of truth again. deriveDeposit is reachable only
  // through the resolver's own fallback rung.
  assert.ok(!/\bdepositDisplay\s*\(/.test(src), 'the deposit route must not call depositDisplay');
  assert.ok(!/\bderiveDeposit\s*\(/.test(src), 'the deposit route must not call deriveDeposit directly');
  // No hand-rolled quote ladder left behind to drift from the resolver.
  assert.ok(!/quotedCutMatches/.test(src), 'the inline quote ladder must be gone (it lives in lib/depositResolve)');
});

test('the resolver stays importable by both paths: no I/O, no cycle', () => {
  const src = readCode('./depositResolve.ts');
  const imports = [...src.matchAll(/^import .*? from ['"](.+?)['"];?$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./pricing'], 'depositResolve may import lib/pricing and nothing else');
  const pricing = readCode('./pricing.ts');
  assert.ok(
    !/from ['"].*depositResolve['"]/.test(pricing),
    'lib/pricing must not import back — that would be a cycle',
  );
});
