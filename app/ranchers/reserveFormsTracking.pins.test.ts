import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Source pins for the ad-tracking contract of the two public reserve forms.
// They are 'use client' components and cannot be imported under `tsx --test`;
// the decisions they render are unit-tested as pure data in
// lib/reserveTracking.test.ts. These pins are what stops the two defects from
// growing back:
//
//   1. AddToCart / InitiateCheckout reporting the rancher's LISTED price
//      instead of the all-in amount the buyer's card is charged.
//   2. A client InitiateCheckout with no event_id, which cannot dedup against
//      the referral-keyed server CAPI fire — one journey, two IC events.
//
// NOTE the path: this file deliberately lives OUTSIDE the [slug] directory.
// The npm test glob is 'app/**/*.test.ts' and a literal `[slug]` segment reads
// as a glob character class, so a test inside it is silently never collected
// (the 2026-08-02 missing-tests landmine).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const connect = readFileSync(path.join(HERE, '[slug]', 'DepositReserveForm.tsx'), 'utf8');
const broker = readFileSync(path.join(HERE, '[slug]', 'BrokerReserve.tsx'), 'utf8');

/** The argument object of one `reserveXEvent({ … })` call site. */
function callArgs(src: string, fn: string, label: string): string {
  const start = src.indexOf(`${fn}({`);
  assert.ok(start > -1, `${label} must call ${fn}({ … })`);
  const end = src.indexOf('});', start);
  assert.ok(end > start, `${label}'s ${fn}({ … }) call must terminate`);
  return src.slice(start, end);
}

const FORMS = [['DepositReserveForm', connect], ['BrokerReserve', broker]] as const;

// ── both forms route their conversion payloads through the shared helper ────

for (const [label, src] of FORMS) {
  test(`PIN: ${label} builds its events with lib/reserveTracking`, () => {
    assert.match(src, /from '@\/lib\/reserveTracking'/);
    assert.match(src, /reserveAddToCartEvent/);
    assert.match(src, /reserveInitiateCheckoutEvent/);
  });

  test(`PIN: ${label} never hand-rolls a track('AddToCart'/'InitiateCheckout') payload`, () => {
    assert.doesNotMatch(src, /track\(\s*'AddToCart'\s*,\s*\{/);
    assert.doesNotMatch(src, /track\(\s*'InitiateCheckout'\s*,\s*\{/);
  });
}

// ── 1. value = the all-in charge, never the listed price ────────────────────

test('PIN: DepositReserveForm feeds the all-in deposit (dueNow) into BOTH events', () => {
  // depositOf() prefers the server-computed depositDue = depositDisplay()
  // .dueNowCents / 100 — deposit + platform fee, exactly what Stripe charges.
  const atc = callArgs(connect, 'reserveAddToCartEvent', 'DepositReserveForm');
  const ic = callArgs(connect, 'reserveInitiateCheckoutEvent', 'DepositReserveForm');
  assert.match(atc, /dueNowDollars:\s*depositOf\(c\),/);
  assert.match(ic, /dueNowDollars:\s*depositOf\(cut\),/);
  // The old bug: the rancher's listed price as the conversion value. `cd(…)`
  // is the raw cut record — its `price` must never reach a conversion payload.
  for (const [where, block] of [['AddToCart', atc], ['InitiateCheckout', ic]] as const) {
    assert.doesNotMatch(block, /cd\(/, `${where} must not read the raw listed price`);
    assert.doesNotMatch(block, /\.price\b/, `${where} must not report a listed price`);
  }
});

test('PIN: BrokerReserve feeds the deposit (the only money charged) into BOTH events', () => {
  // Broker rail: the card is charged the deposit and nothing else — the
  // balance goes to the ranch off-platform (lib/brokerCapi VALUE SEMANTICS).
  const atc = callArgs(broker, 'reserveAddToCartEvent', 'BrokerReserve');
  const ic = callArgs(broker, 'reserveInitiateCheckoutEvent', 'BrokerReserve');
  assert.match(atc, /dueNowDollars:\s*c\.depositCents\s*\/\s*100,/);
  assert.match(ic, /dueNowDollars:\s*selected\.depositCents\s*\/\s*100,/);
  for (const [where, block] of [['AddToCart', atc], ['InitiateCheckout', ic]] as const) {
    assert.doesNotMatch(block, /priceCents/, `${where} must not report the share price`);
  }
});

// ── 2. the client InitiateCheckout dedups against the server fire ───────────

test('PIN: DepositReserveForm passes the referral id the reserve API returns', () => {
  const ic = callArgs(connect, 'reserveInitiateCheckoutEvent', 'DepositReserveForm');
  assert.match(ic, /referralId:\s*j\.referralId,/);
});

test('PIN: BrokerReserve recovers the referral id from the redirect it is given', () => {
  // The broker endpoint returns only { redirect }, so the id is read off the
  // path — fail-closed helper, never a hand-rolled split().
  const ic = callArgs(broker, 'reserveInitiateCheckoutEvent', 'BrokerReserve');
  assert.match(ic, /referralId:\s*referralIdFromCheckoutPath\(j\.redirect\),/);
  assert.match(broker, /from '@\/lib\/reserveTracking'/);
});

test('PIN: neither form fires InitiateCheckout without a referral id to dedup on', () => {
  for (const [label, src] of FORMS) {
    const ic = callArgs(src, 'reserveInitiateCheckoutEvent', label);
    assert.match(ic, /referralId:/, `${label}'s InitiateCheckout must carry a referral id`);
  }
});
