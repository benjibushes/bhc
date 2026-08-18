// ⚠️ THE MONEY GUARD.
//
// If these tests go green while the guard is gone, BHC silently earns $0 on
// every broker match. That is the failure they exist to make impossible, so
// each one is written to BITE: the fixtures pass every other gate, and the
// assertions name the exact leak rather than the shape of the code.
//
// THE LEAK, stated once: on the broker rail BHC's ENTIRE fee is the deposit
// the buyer pays on BHC's own Stripe account. Hand a matched buyer the ranch's
// email and phone (which sendBuyerIntroNotification does) and the two of them
// simply transact directly — ranch paid, buyer fed, BHC paid nothing on a lead
// it sourced, qualified and routed.
//
// Synthetic names only — the repo is PUBLIC.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  planMatchNotifications,
  isBrokerMatch,
  brokerCutForOrderType,
  brokerMatchDestinationPath,
  brokerMatchInviteFor,
  buildBrokerMatchInvite,
  buildBrokerMatchOperatorCard,
} from './brokerMatch';
import { buildBrokerSelfServeView } from './brokerSelfServe';

function selfServeBrokerRanch(over: Record<string, any> = {}) {
  return {
    id: 'recSELFSERVE0001',
    'Ranch Name': 'Dry Wash Cattle',
    'Operator Name': 'Sam Rivers',
    State: 'AZ',
    Slug: 'dry-wash-cattle',
    Email: 'ranch@example.com',
    Phone: '+15555550123',
    'Broker Rail': true,
    'Broker Self Serve': true,
    'Quarter Price': 1100,
    'Quarter Deposit': 250,
    'Half Price': 2100,
    'Half Deposit': 450,
    ...over,
  };
}

function connectRancher(over: Record<string, any> = {}) {
  return {
    id: 'recCONNECT000001',
    'Ranch Name': 'Stone Fork Beef',
    State: 'MT',
    Slug: 'stone-fork-beef',
    Email: 'ranch2@example.com',
    Phone: '+15555550456',
    'Active Status': 'Active',
    'Agreement Signed': true,
    'Onboarding Status': 'Live',
    'Pricing Model': 'tier_v2',
    'Stripe Connect Status': 'active',
    'Half Price': 2100,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// THE PLAN — the decision every send site obeys
// ---------------------------------------------------------------------------

test('MONEY GUARD: a broker match NEVER emails the rancher a lead, NEVER hands the buyer contact details, NEVER texts "expect a call"', () => {
  const plan = planMatchNotifications(selfServeBrokerRanch());
  assert.equal(plan.rail, 'broker');
  assert.equal(plan.rancherLeadEmail, false, 'a represented ranch must never get a Connect lead email');
  assert.equal(plan.buyerIntroHandoff, false, 'REVENUE LEAK: the buyer would get the ranch email + phone');
  assert.equal(plan.expectACallSms, false, 'nobody is calling — and the text invites a direct deal');
  assert.equal(plan.brokerReserveInvite, true, 'the buyer must still hear from us, deposit-first');
  assert.equal(plan.operatorHandoffAlert, true, 'Ben is the coordination on this rail');
});

test('MONEY GUARD: the guard keys on the RAIL, not on routability — a broker ranch reached by any path is still deposit-first', () => {
  // A pinned `?rancher=` campaign, an admin reassign, or a flag flipped
  // mid-request can all land a NON-routable broker ranch at the end of the
  // pipeline. What may be SENT is decided by the rail alone.
  const notRoutable = selfServeBrokerRanch({ Slug: '', 'Broker Self Serve': undefined });
  const plan = planMatchNotifications(notRoutable);
  assert.equal(plan.rail, 'broker');
  assert.equal(plan.buyerIntroHandoff, false);
  assert.equal(plan.rancherLeadEmail, false);
});

test('a Connect match is byte-unchanged: rancher lead + buyer intro + SMS all still fire', () => {
  const plan = planMatchNotifications(connectRancher());
  assert.equal(plan.rail, 'connect');
  assert.equal(plan.rancherLeadEmail, true);
  assert.equal(plan.buyerIntroHandoff, true);
  assert.equal(plan.expectACallSms, true);
  assert.equal(plan.brokerReserveInvite, false);
  assert.equal(plan.operatorHandoffAlert, false);
  assert.equal(isBrokerMatch(connectRancher()), false);
});

test('the plan fails CLOSED on garbage input (never a Connect send for an unreadable rancher)', () => {
  // A non-broker read of an unreadable row yields the Connect plan, which is
  // the pre-existing behavior for every non-broker rancher — but a row that
  // reads as broker in ANY accepted form must take the broker plan.
  for (const raw of [{ 'Broker Rail': true }, { 'Broker Rail': 'true' }, { 'Broker Rail': 'TRUE' }]) {
    assert.equal(planMatchNotifications(raw).buyerIntroHandoff, false, JSON.stringify(raw));
  }
  // 'false' as a STRING is truthy in JS — it must NOT read as broker.
  assert.equal(planMatchNotifications({ 'Broker Rail': 'false' }).rail, 'connect');
});

// ---------------------------------------------------------------------------
// THE ROUTE OBEYS THE PLAN — source pins.
//
// The plan being right is worthless if the route stops consulting it. These
// pin the three send sites to their guards, in the route's own source (an App
// Router route file cannot be imported under tsx --test — it pulls the whole
// Airtable/Stripe/Resend stack at module load). Same convention as
// route.pins.test.ts and lib/brokerSettlement.test.ts.
// ---------------------------------------------------------------------------

const ROUTE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'app', 'api', 'matching', 'suggest', 'route.ts',
);
const routeSrc = readFileSync(ROUTE, 'utf8');

test('ROUTE PIN: the rail is decided ONCE, from the claimed rancher, via lib/brokerMatch', () => {
  assert.match(routeSrc, /import \{[\s\S]*?planMatchNotifications[\s\S]*?\} from '@\/lib\/brokerMatch'/);
  assert.match(routeSrc, /const notifyPlan = planMatchNotifications\(topMatch\);/);
  // Decided AFTER the claim, so it describes the rancher actually matched.
  assert.ok(
    routeSrc.indexOf('topMatch = claimedRancher;') <
      routeSrc.indexOf('const notifyPlan = planMatchNotifications(topMatch);'),
  );
});

test('ROUTE PIN (money): the rancher lead email is gated on notifyPlan.rancherLeadEmail', () => {
  assert.match(routeSrc, /if \(rancherEmail && notifyPlan\.rancherLeadEmail\) \{/);
  // ...and the thing it guards really is the Connect lead email: the 30-day
  // quick-action JWT and the commission-invoice claim live inside it.
  const guardIdx = routeSrc.indexOf('if (rancherEmail && notifyPlan.rancherLeadEmail) {');
  assert.ok(guardIdx > -1);
  assert.ok(routeSrc.indexOf("type: 'rancher-quick-action'", guardIdx) > guardIdx);
  assert.ok(routeSrc.indexOf('10% commission invoice', guardIdx) > guardIdx);
});

test('ROUTE PIN (money): the buyer intro handoff is gated on notifyPlan.buyerIntroHandoff', () => {
  assert.match(routeSrc, /if \(!suppressBuyerIntro && notifyPlan\.buyerIntroHandoff\) try \{/);
  // The guarded call is the one that reveals the ranch's contact details.
  const guardIdx = routeSrc.indexOf('if (!suppressBuyerIntro && notifyPlan.buyerIntroHandoff) try {');
  const callIdx = routeSrc.indexOf('await sendBuyerIntroNotification({', guardIdx);
  assert.ok(callIdx > guardIdx, 'sendBuyerIntroNotification must sit INSIDE the guard');
  const call = routeSrc.slice(callIdx, callIdx + 900);
  assert.match(call, /rancherEmail,/);
  assert.match(call, /rancherPhone,/);
  // There is exactly ONE call site — an ungated second one would reopen the leak.
  assert.equal(routeSrc.split('sendBuyerIntroNotification(').length - 1, 1);
});

test('ROUTE PIN (money): the expect-a-call SMS is gated on notifyPlan.expectACallSms', () => {
  assert.match(routeSrc, /if \(buyerPhone && notifyPlan\.expectACallSms && isSmsWindow\(/);
  const guardIdx = routeSrc.indexOf('notifyPlan.expectACallSms');
  const smsIdx = routeSrc.indexOf('sendSMSToConsumer({', guardIdx);
  assert.ok(smsIdx > guardIdx);
  assert.match(routeSrc.slice(smsIdx, smsIdx + 700), /they'll text or call you/);
});

test('ROUTE PIN (money): the broker branch sends the reserve invite and alerts BEN, not the ranch', () => {
  assert.match(routeSrc, /if \(notifyPlan\.brokerReserveInvite\) \{/);
  assert.match(routeSrc, /await sendBrokerMatchInvite\(\{/);
  assert.match(routeSrc, /if \(notifyPlan\.operatorHandoffAlert\) \{/);
  assert.match(routeSrc, /buildBrokerMatchOperatorCard\(\{/);
});

test('ROUTE PIN (dedupe): a matching-created broker referral carries the exact BROKER_MATCH_TYPE', () => {
  assert.match(routeSrc, /import \{ BROKER_MATCH_TYPE, CUT_LABELS \} from '@\/lib\/brokerRail'/);
  assert.match(routeSrc, /'Match Type': isBrokerRailMatch\s*\n?\s*\? BROKER_MATCH_TYPE/);
  // No hardcoded copy of the literal — lib/brokerReferral reuses on a
  // byte-exact match, so a drifted string spawns duplicate referrals.
  assert.doesNotMatch(routeSrc, /'Broker — Deposit'/);
});

// ---------------------------------------------------------------------------
// WHERE THE BUYER IS SENT
// ---------------------------------------------------------------------------

test('brokerCutForOrderType maps the buyer\'s requested share (and never guesses)', () => {
  assert.equal(brokerCutForOrderType('Quarter Cow'), 'quarter');
  assert.equal(brokerCutForOrderType('half'), 'half');
  assert.equal(brokerCutForOrderType('Whole Cow — ~440 lbs'), 'whole');
  assert.equal(brokerCutForOrderType('Not Sure'), null);
  assert.equal(brokerCutForOrderType(''), null);
  assert.equal(brokerCutForOrderType(undefined), null);
});

test('destination: a known cut deep-links to the EXISTING broker deposit page', () => {
  const d = brokerMatchDestinationPath({ slug: 'dry-wash-cattle', referralId: 'recREF01', cut: 'half' });
  assert.deepEqual(d, { kind: 'deep', path: '/checkout/recREF01/broker?cut=half' });
});

test('destination: an unknown cut falls back to the ranch\'s own reserve page', () => {
  const d = brokerMatchDestinationPath({ slug: 'dry-wash-cattle', referralId: 'recREF01', cut: null });
  assert.deepEqual(d, { kind: 'page', path: '/ranchers/dry-wash-cattle' });
});

test('destination: never a raw Stripe URL, and never the Connect deposit page', () => {
  for (const cut of ['quarter', 'half', 'whole', null] as const) {
    const { path: p } = brokerMatchDestinationPath({ slug: 's', referralId: 'recR', cut });
    assert.doesNotMatch(p, /stripe\.com|checkout\.stripe/);
    assert.doesNotMatch(p, /\/deposit$/, 'that is the CONNECT deposit page');
  }
});

// ---------------------------------------------------------------------------
// THE BUYER EMAIL — copy contract
// ---------------------------------------------------------------------------

const invite = () =>
  brokerMatchInviteFor({
    rancher: selfServeBrokerRanch({
      'Broker Balance Note': 'Pay the ranch by cash or check at pickup.',
      'Broker Additional Costs': 'The butcher bills you directly for cut and wrap.',
    }),
    buyerFirstName: 'Alex',
    reserveUrl: 'https://www.buyhalfcow.com/checkout/recREF01/broker?cut=half',
    requestedCutLabel: 'Half Cow',
  })!;

test('BUYER COPY: never reveals that the deposit is BHC\'s commission', () => {
  const built = invite();
  const all = `${built.subject}\n${built.html}\n${built.text}`.toLowerCase();
  for (const forbidden of ['commission', 'our fee', 'our cut', 'we keep', 'brokerage', 'markup']) {
    assert.ok(!all.includes(forbidden), `buyer copy leaked "${forbidden}"`);
  }
});

test('BUYER COPY: never contains the ranch\'s email or phone — that is the whole leak', () => {
  const built = invite();
  const all = `${built.html}\n${built.text}`;
  assert.ok(!all.includes('ranch@example.com'), 'REVENUE LEAK: ranch email in the buyer email');
  assert.ok(!all.includes('5555550123'), 'REVENUE LEAK: ranch phone in the buyer email');
});

test('BUYER COPY: says deposit toward the share, balance to the RANCH, and discloses the butcher bill', () => {
  const built = invite();
  assert.match(built.text, /\$450 deposit today/);
  assert.match(built.text, /\$1,650 to the ranch/);
  assert.match(built.text, /balance to Dry Wash Cattle directly/);
  assert.match(built.text, /cash or check at pickup/);
  assert.match(built.text, /butcher bills you directly/);
});

test('BUYER COPY: exactly ONE CTA, and it is the deposit surface', () => {
  const built = invite();
  const hrefs = [...built.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ['https://www.buyhalfcow.com/checkout/recREF01/broker?cut=half']);
});

test('BUYER COPY: a weight-priced cut states an ESTIMATED RANGE, never an exact balance', () => {
  const rancher = selfServeBrokerRanch({
    'Quarter Price': null, 'Quarter Deposit': null,
    'Half Price Max': 2600,
    'Broker Pricing Note': 'Final price is set by hanging weight at $4.10/lb.',
  });
  const built = buildBrokerMatchInvite({
    buyerFirstName: 'Alex',
    ranchName: 'Dry Wash Cattle',
    ranchState: 'AZ',
    reserveUrl: 'https://example.test/x',
    view: buildBrokerSelfServeView(rancher),
  });
  assert.match(built.text, /estimated \$2,100–\$2,600 total/);
  assert.match(built.text, /\$1,650–\$2,150 to the ranch/);
  assert.match(built.text, /hanging weight/);
});

test('BUYER COPY: a ranch with no sellable cut yields NO email rather than a bouncing link', () => {
  const unsellable = selfServeBrokerRanch({
    'Quarter Price': null, 'Quarter Deposit': null,
    'Half Price': null, 'Half Deposit': null,
  });
  assert.equal(
    brokerMatchInviteFor({ rancher: unsellable, buyerFirstName: 'Alex', reserveUrl: 'https://x.test' }),
    null,
  );
});

// ---------------------------------------------------------------------------
// THE OPERATOR CARD — Ben, not the ranch
// ---------------------------------------------------------------------------

test('OPERATOR CARD: states plainly that the ranch was not notified, and escalates when no invite went out', () => {
  const ok = buildBrokerMatchOperatorCard({
    ranchName: 'Dry Wash Cattle', ranchState: 'AZ',
    buyerName: 'Alex R', buyerState: 'AZ', orderType: 'Half Cow',
    reserveUrl: 'https://x.test/r', invited: true,
  });
  assert.match(ok.summary, /BROKER MATCH/);
  assert.match(ok.summary, /ranch NOT notified/);
  assert.match(ok.detail, /never given its email or phone/);

  const failed = buildBrokerMatchOperatorCard({
    ranchName: 'Dry Wash Cattle', ranchState: 'AZ',
    buyerName: 'Alex R', buyerState: 'AZ', orderType: '',
    reserveUrl: 'https://x.test/r', invited: false,
  });
  assert.match(failed.detail, /NO buyer email went out/);
  assert.match(failed.detail, /reach out by hand/);
});
