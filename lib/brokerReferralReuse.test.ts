// BROKER REFERRAL — find-or-create, now that the MATCHING ENGINE also mints
// these rows.
//
// TWO BUGS THIS PINS, both created by making self-serve broker ranches
// routable:
//
//  1. DUPLICATION. lib/brokerReferral reuses an open referral only on a
//     byte-exact `Match Type === BROKER_MATCH_TYPE`. A routed buyer who then
//     self-serves on the ranch's page must land back on THEIR row — so the
//     matching engine has to stamp that exact constant. Any drift (a friendlier
//     label, a different dash) silently spawns a second referral for the same
//     buyer↔ranch, which is how one buyer ends up charged twice or the money
//     truth ends up on the row nobody looks at.
//
//  2. BLANK MONEY ON REUSE. The reuse branch stamped nothing, on the assumption
//     that any row it found had been created here and already carried the
//     money. A matching-created row has no cut chosen yet, so it is created
//     with blank price and deposit — and reusing it carried those blanks
//     straight to checkout.
//
// Synthetic names only — the repo is PUBLIC.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isReusableBrokerReferral,
  brokerReferralMoneyFields,
  brokerReferralNotes,
} from './brokerReferral';
import { assertBrokerEligible, BROKER_MATCH_TYPE } from './brokerRail';

const RANCHER = 'recSELFSERVE0001';
const OTHER_RANCHER = 'recOTHERRANCH001';

function row(over: Record<string, any> = {}) {
  return {
    id: 'recREF00000001',
    Status: 'Intro Sent',
    'Match Type': BROKER_MATCH_TYPE,
    Rancher: [RANCHER],
    ...over,
  };
}

function quoteFor(cut: 'quarter' | 'half' | 'whole', over: Record<string, any> = {}) {
  const gate = assertBrokerEligible(
    {
      'Broker Rail': true,
      'Quarter Price': 1100, 'Quarter Deposit': 250,
      'Half Price': 2100, 'Half Deposit': 450,
      'Whole Price': 4000, 'Whole Deposit': 850,
      ...over,
    },
    cut,
  );
  assert.ok(gate.ok, 'fixture must be sellable');
  return gate.quote;
}

// ---------------------------------------------------------------------------
// DEDUPE
// ---------------------------------------------------------------------------

test('DEDUPE: the matching engine stamps the SAME constant the reuse filter matches on', () => {
  // The cross-file contract. If either side hardcodes the literal and the other
  // changes, a routed buyer who self-serves gets a duplicate referral.
  const routeSrc = readFileSync(
    fileURLToPath(new URL('../app/api/matching/suggest/route.ts', import.meta.url)),
    'utf8',
  );
  assert.match(routeSrc, /BROKER_MATCH_TYPE/);
  assert.equal(BROKER_MATCH_TYPE, 'Broker — Deposit');
  // A row carrying exactly what the route stamps is reusable here.
  assert.equal(isReusableBrokerReferral(row({ 'Match Type': BROKER_MATCH_TYPE }), RANCHER), true);
});

test('DEDUPE: a matching-created broker row IS reused (no duplicate on a later self-serve reserve)', () => {
  // Exactly the shape matching/suggest leaves behind: Intro Sent, linked
  // Rancher, BROKER_MATCH_TYPE, and no cut chosen yet.
  const routed = row({ Status: 'Intro Sent', 'Order Type': '', 'Total Sale Amount': null });
  assert.equal(isReusableBrokerReferral(routed, RANCHER), true);
});

test('DEDUPE: a near-miss Match Type is NOT reused (byte-exact or it duplicates)', () => {
  for (const mt of ['Broker - Deposit', 'broker — deposit', 'Broker — Deposit ', 'Broker', '', 'Local']) {
    assert.equal(
      isReusableBrokerReferral(row({ 'Match Type': mt }), RANCHER),
      false,
      `"${mt}" was treated as a broker referral`,
    );
  }
});

test('DEDUPE: a CONNECT deposit referral for the same buyer is never hijacked', () => {
  // Crossing the rails here would charge a Connect buyer under broker economics.
  assert.equal(
    isReusableBrokerReferral(row({ 'Match Type': 'Direct (Rancher Page) — Deposit' }), RANCHER),
    false,
  );
});

test('DEDUPE: a row for a DIFFERENT ranch is never reused', () => {
  assert.equal(isReusableBrokerReferral(row({ Rancher: [OTHER_RANCHER] }), RANCHER), false);
  assert.equal(isReusableBrokerReferral(row({ Rancher: [] }), RANCHER), false);
  assert.equal(isReusableBrokerReferral(row(), ''), false);
  assert.equal(isReusableBrokerReferral(null, RANCHER), false);
});

test('DEDUPE: dead or already-settled rows are never reused', () => {
  for (const status of ['Closed Won', 'Closed Lost', 'Awaiting Payment', 'Slot Locked']) {
    assert.equal(
      isReusableBrokerReferral(row({ Status: status }), RANCHER),
      false,
      `reused a ${status} referral`,
    );
  }
  // Open statuses stay reusable.
  for (const status of ['Pending', 'Intro Sent', 'Negotiation', 'Rancher Contacted']) {
    assert.equal(isReusableBrokerReferral(row({ Status: status }), RANCHER), true, status);
  }
});

test('DEDUPE: a Suggested-Rancher-only link still matches (pre-intro rows)', () => {
  const suggested = row({ Rancher: undefined, 'Suggested Rancher': [RANCHER] });
  delete (suggested as any).Rancher;
  assert.equal(isReusableBrokerReferral(suggested, RANCHER), true);
});

// ---------------------------------------------------------------------------
// MONEY ON REUSE
// ---------------------------------------------------------------------------

test('MONEY: the reuse stamp carries price, deposit and cut for the CHOSEN cut', () => {
  const fields = brokerReferralMoneyFields(quoteFor('half'));
  assert.equal(fields['Order Type'], 'Half Cow');
  assert.equal(fields['Total Sale Amount'], 2100);
  assert.equal(fields['Deposit Amount'], 450);
  assert.equal(fields.Notes, brokerReferralNotes(quoteFor('half')));
  // No blanks — the whole point.
  for (const k of ['Order Type', 'Total Sale Amount', 'Deposit Amount', 'Notes']) {
    assert.ok(fields[k] !== '' && fields[k] !== null && fields[k] !== undefined, `${k} was blank`);
  }
});

test('MONEY: choosing a different cut on reuse re-stamps that cut, not the routed guess', () => {
  const q = brokerReferralMoneyFields(quoteFor('quarter'));
  assert.equal(q['Order Type'], 'Quarter Cow');
  assert.equal(q['Total Sale Amount'], 1100);
  assert.equal(q['Deposit Amount'], 250);
});

test('MONEY: a WEIGHT-PRICED cut stamps the range FLOOR and records the range in Notes', () => {
  const fields = brokerReferralMoneyFields(quoteFor('half', { 'Half Price Max': 2600 }));
  assert.equal(fields['Total Sale Amount'], 2100, 'must stamp the FLOOR, never the ceiling');
  assert.equal(fields['Deposit Amount'], 450, 'the deposit is exact in both pricing modes');
  assert.match(fields.Notes, /weight-priced/);
  assert.match(fields.Notes, /\$2,100–\$2,600/);
});

test('WIRING: both branches stamp money from the ONE shared builder', () => {
  const src = readFileSync(fileURLToPath(new URL('./brokerReferral.ts', import.meta.url)), 'utf8');
  // Reuse branch.
  assert.match(src, /await updateRecord\(TABLES\.REFERRALS, match\.id, brokerReferralMoneyFields\(gate\.quote\)\)/);
  // Create branch.
  assert.match(src, /\.\.\.brokerReferralMoneyFields\(gate\.quote\),/);
  // Neither branch hand-rolls the money fields any more.
  assert.doesNotMatch(src, /'Total Sale Amount': gate\.quote/);
  assert.doesNotMatch(src, /'Deposit Amount': gate\.quote/);
});

test('WIRING: the reuse stamp is best-effort — an Airtable blip never blocks a paying buyer', () => {
  const src = readFileSync(fileURLToPath(new URL('./brokerReferral.ts', import.meta.url)), 'utf8');
  const at = src.indexOf('await updateRecord(TABLES.REFERRALS, match.id, brokerReferralMoneyFields');
  assert.ok(at > -1);
  const around = src.slice(at - 200, at + 400);
  assert.match(around, /try \{/);
  assert.match(around, /reuse money stamp failed/);
  assert.match(around, /return \{ ok: true, referralId: match\.id, created: false, rancher \};/);
});
