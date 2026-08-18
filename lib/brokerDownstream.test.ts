// THE SHARED RAIL PREDICATE — unit tests.
//
// lib/referralRail is the ONE answer to "which money rail is this referral on,
// and what may I therefore send?" for every downstream rail that keys off a
// referral row. Its whole reason to exist is that five independent inline
// checks drift; these tests pin the contract they all share.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rancherIdForReferral,
  referralCarriesBrokerMarker,
  railForLoadedRancher,
  resolveReferralRail,
  mayRevealRancherContact,
  BROKER_RAIL_FAIL_CLOSED,
} from './brokerDownstream';

const brokerRancher = () => ({ id: 'recBRK', 'Broker Rail': true, 'Ranch Name': 'R1' });
const connectRancher = () => ({ id: 'recCON', 'Ranch Name': 'R2', 'Stripe Connect Account Id': 'acct_1' });

// ---------------------------------------------------------------------------
// Which rancher does a referral point at?
// ---------------------------------------------------------------------------

test('rancherIdForReferral: Rancher wins, Suggested Rancher is the fallback', () => {
  assert.equal(rancherIdForReferral({ Rancher: ['recA'], 'Suggested Rancher': ['recB'] }), 'recA');
  assert.equal(rancherIdForReferral({ 'Suggested Rancher': ['recB'] }), 'recB');
  assert.equal(rancherIdForReferral({}), '');
  assert.equal(rancherIdForReferral(null), '');
  // Airtable sometimes hands back a bare string on a single-link field.
  assert.equal(rancherIdForReferral({ Rancher: 'recA' }), 'recA');
  // Empty arrays must not become the string "undefined".
  assert.equal(rancherIdForReferral({ Rancher: [], 'Suggested Rancher': [] }), '');
});

// ---------------------------------------------------------------------------
// Referral-side marker — conclusive POSITIVE, never a negative
// ---------------------------------------------------------------------------

test('referralCarriesBrokerMarker: the mint-time Match Type is conclusive on its own', () => {
  assert.equal(referralCarriesBrokerMarker({ 'Match Type': 'Broker — Deposit' }), true);
  // singleSelect object form
  assert.equal(referralCarriesBrokerMarker({ 'Match Type': { name: 'Broker — Deposit' } }), true);
  // A CONNECT row carries no marker — and absence proves NOTHING (the rancher
  // lookup is what settles it). This assertion pins "false", not "connect".
  assert.equal(referralCarriesBrokerMarker({ 'Match Type': 'Quiz Match' }), false);
  assert.equal(referralCarriesBrokerMarker({}), false);
  assert.equal(referralCarriesBrokerMarker(null), false);
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED — the whole point
// ---------------------------------------------------------------------------

test('railForLoadedRancher: a real row decides; an UNREADABLE rancher fails closed to broker', () => {
  assert.equal(railForLoadedRancher(brokerRancher()), 'broker');
  assert.equal(railForLoadedRancher(connectRancher()), 'connect');
  // The fail-closed cases: nothing to read = we cannot prove Connect.
  assert.equal(railForLoadedRancher(null), BROKER_RAIL_FAIL_CLOSED);
  assert.equal(railForLoadedRancher(undefined), BROKER_RAIL_FAIL_CLOSED);
  assert.equal(railForLoadedRancher('recSomething'), BROKER_RAIL_FAIL_CLOSED);
  assert.equal(BROKER_RAIL_FAIL_CLOSED, 'broker');
});

test('railForLoadedRancher: a readable row with NO Broker Rail key is CONNECT, not ambiguous', () => {
  // Airtable omits unchecked checkboxes from the fields payload entirely, so
  // "no `Broker Rail` key" is the NORMAL wire shape of a Connect rancher. If
  // this ever flipped to broker, every Connect match in the system would stop.
  assert.equal(railForLoadedRancher({ id: 'recX', 'Ranch Name': 'R' }), 'connect');
});

// ---------------------------------------------------------------------------
// The async resolver every downstream site calls
// ---------------------------------------------------------------------------

test('resolveReferralRail: loads the linked rancher and answers from it', async () => {
  const calls: string[] = [];
  const load = async (id: string) => { calls.push(id); return id === 'recBRK' ? brokerRancher() : connectRancher(); };
  assert.equal(await resolveReferralRail({ Rancher: ['recBRK'] }, load), 'broker');
  assert.equal(await resolveReferralRail({ Rancher: ['recCON'] }, load), 'connect');
  assert.deepEqual(calls, ['recBRK', 'recCON']);
});

test('resolveReferralRail: the Match Type marker short-circuits the lookup entirely', async () => {
  let called = 0;
  const load = async () => { called++; return connectRancher(); };
  assert.equal(
    await resolveReferralRail({ Rancher: ['recCON'], 'Match Type': 'Broker — Deposit' }, load),
    'broker',
  );
  assert.equal(called, 0, 'a broker-marked row needs no rancher read');
});

test('resolveReferralRail: a THROWING loader fails closed to broker (never leaks on a blip)', async () => {
  const load = async () => { throw new Error('airtable 503'); };
  assert.equal(await resolveReferralRail({ Rancher: ['recCON'] }, load), 'broker');
});

test('resolveReferralRail: a loader returning null fails closed to broker', async () => {
  const load = async () => null;
  assert.equal(await resolveReferralRail({ Rancher: ['recCON'] }, load), 'broker');
});

test('resolveReferralRail: no rancher linked at all fails closed to broker', async () => {
  let called = 0;
  const load = async () => { called++; return connectRancher(); };
  assert.equal(await resolveReferralRail({}, load), 'broker');
  assert.equal(called, 0, 'nothing to load');
});

test('resolveReferralRail: an ALREADY-LOADED rancher is used without a second read', async () => {
  let called = 0;
  const load = async () => { called++; return connectRancher(); };
  assert.equal(await resolveReferralRail({ Rancher: ['recBRK'], __rancher: brokerRancher() }, load), 'broker');
  assert.equal(await resolveReferralRail({ Rancher: ['recCON'], __rancher: connectRancher() }, load), 'connect');
  assert.equal(called, 0);
});

// ---------------------------------------------------------------------------
// The buyer-facing question: may this buyer SEE the ranch's email/phone?
// ---------------------------------------------------------------------------

test('mayRevealRancherContact: Connect reveals always — that rail is an introduction', () => {
  assert.equal(mayRevealRancherContact({}, 'connect'), true);
  assert.equal(mayRevealRancherContact({ Status: 'Intro Sent' }, 'connect'), true);
});

test('mayRevealRancherContact: BROKER hides until the deposit is paid, then reveals', () => {
  // Before the deposit, the ranch's phone number IS the revenue leak: the buyer
  // and ranch transact direct and BHC earns nothing on a lead it sourced.
  assert.equal(mayRevealRancherContact({ Status: 'Intro Sent' }, 'broker'), false);
  assert.equal(mayRevealRancherContact({ Status: 'Pending Approval' }, 'broker'), false);
  assert.equal(mayRevealRancherContact({ 'Deposit Requested At': '2026-08-17T00:00:00Z' }, 'broker'), false);
  // Deposit paid = BHC has collected its ENTIRE fee on this sale. The buyer now
  // owes the ranch the balance directly and must be able to reach them — the
  // broker settlement receipt (lib/brokerNotify) already hands over the same
  // details, so hiding them here would only break the dashboard.
  assert.equal(mayRevealRancherContact({ 'Deposit Paid At': '2026-08-17T00:00:00Z' }, 'broker'), true);
});

test('mayRevealRancherContact: a blank/whitespace Deposit Paid At is NOT paid', () => {
  assert.equal(mayRevealRancherContact({ 'Deposit Paid At': '' }, 'broker'), false);
  assert.equal(mayRevealRancherContact({ 'Deposit Paid At': '   ' }, 'broker'), false);
  assert.equal(mayRevealRancherContact({ 'Deposit Paid At': null }, 'broker'), false);
});
