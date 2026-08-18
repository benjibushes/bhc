// DOWNSTREAM GATES — what must NOT start touching a represented ranch now that
// a self-serve one is routable supply.
//
// Making isRancherOperationalForBuyers return true for a self-serve broker
// ranch silently opened every path whose ONLY rancher gate was that predicate
// (or, worse, a blank `Active Status`). Each test below names one such path and
// the specific wrong thing it would have done.
//
// The rule these all enforce: the self-serve opt-in is DEMAND-side only.
// Buyers may be routed to a represented ranch; nothing may be sent TO it, and
// nothing may write onboarding state onto it. It has no login, signed no
// agreement, and is on no Connect account.
//
// Route/cron handlers cannot be imported under tsx --test (they pull the whole
// Airtable/Stripe/Resend stack at module load), so these are source pins —
// the same convention as app/api/matching/suggest/route.pins.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brokerReserveCta, requalifyCta, renderRequalifyEmail } from './requalifyCampaign';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------
// 1. ONBOARDING STATE — never written to a ranch that never onboarded
// ---------------------------------------------------------------------------

test('GATE trust-promotion: represented ranches are dropped at the read boundary', () => {
  const src = read('../app/api/cron/rancher-trust-promotion/route.ts');
  // Without this, a represented ranch (no `Onboarding Phase Until`, created
  // >30d ago) hits the legacy-graduation branch and gets `Trust Mode: true`
  // written to it on the very first run — a rancher-side write, plus a
  // promotion Telegram, for a ranch that never onboarded.
  assert.match(src, /import \{ excludeBrokerRanchers \} from '@\/lib\/brokerRail'/);
  assert.match(src, /const allRanchers = excludeBrokerRanchers\(allRanchersRaw\);/);
  const excludeIdx = src.indexOf('excludeBrokerRanchers(allRanchersRaw)');
  const filterIdx = src.indexOf('allRanchers.filter(isRancherOperationalForBuyers)');
  assert.ok(excludeIdx > -1 && filterIdx > excludeIdx, 'the exclusion must precede the operational filter');
  assert.ok(src.indexOf("'Trust Mode': true") > filterIdx);
});

// ---------------------------------------------------------------------------
// 2. WRONG-RAIL RANCHER INTROS — the "10% commission" emails
// ---------------------------------------------------------------------------

test('GATE bulkRoute: refuses a represented ranch before any rancher intro fires', () => {
  const src = read('./bulkRoute.ts');
  assert.match(src, /import \{ isBrokerRancher \} from '\.\/brokerRail'/);
  assert.match(src, /if \(isBrokerRancher\(rancher\)\) \{/);
  const gateIdx = src.indexOf('if (isBrokerRancher(rancher)) {');
  // Everything wrong it would have sent sits AFTER the refusal.
  assert.ok(src.indexOf('/rancher/inbox', gateIdx) > gateIdx, 'dashboard link a broker ranch has no login for');
  assert.ok(src.indexOf('10% commission on BHC referral sales', gateIdx) > gateIdx, 'wrong money model');
  assert.ok(src.indexOf('BuyHalfCow Introduction:', gateIdx) > gateIdx);
});

test('GATE admin reassign: refuses a represented ranch as a reassign target', () => {
  const src = read('../app/api/admin/referrals/[id]/reassign/route.ts');
  assert.match(src, /import \{ isBrokerRancher \} from '@\/lib\/brokerRail'/);
  assert.match(src, /if \(isBrokerRancher\(newRancher\)\) \{/);
  const gateIdx = src.indexOf('if (isBrokerRancher(newRancher)) {');
  // The intro this blocks claims "our 10% is added on top" — false on a rail
  // where the ranch nets price − deposit and nothing is added on top.
  assert.ok(src.indexOf('our 10% is added on top', gateIdx) > gateIdx);
});

// ---------------------------------------------------------------------------
// 3. SLA CHASES — no "you are still waiting on your first call" to a ranch
//    that is waiting on a deposit
// ---------------------------------------------------------------------------

test('GATE first-touch-sla: the 48h nudge skips broker EXPLICITLY, not via blank Active Status', () => {
  const src = read('../app/api/cron/first-touch-sla/route.ts');
  assert.match(src, /import \{ isBrokerRancher \} from '@\/lib\/brokerRail'/);
  assert.match(src, /if \(isBrokerRancher\(rancher\)\) \{ skip\('broker-rail'\); continue; \}/);
  // It must sit BEFORE the Active Status line, which was the accidental belt —
  // one admin checkbox from emailing a represented ranch.
  const brokerIdx = src.indexOf("if (isBrokerRancher(rancher)) { skip('broker-rail'); continue; }");
  const activeIdx = src.indexOf("if (str(rancher['Active Status']) !== 'Active') { skip('rancher-inactive'); continue; }");
  assert.ok(brokerIdx > -1 && activeIdx > brokerIdx, 'the broker skip must not depend on Active Status');
});

test('GATE first-touch-sla: the 96h escalation half is gated too (it had NO rancher gate at all)', () => {
  const src = read('../app/api/cron/first-touch-sla/route.ts');
  assert.match(src, /if \(rancher && isBrokerRancher\(rancher\)\) \{ skip\('broker-rail'\); continue; \}/);
  // Its card carries a "Nudge Rancher" button whose callback emails the ranch.
  const gateIdx = src.indexOf("if (rancher && isBrokerRancher(rancher)) { skip('broker-rail'); continue; }");
  assert.ok(src.indexOf('nudgerancher_', gateIdx) > gateIdx);
});

test('GATE deposit-accept SLA: the PR #625 broker exclusion still holds under the new routable state', () => {
  const src = read('./depositSla.ts');
  // It keys on the raw `Broker Rail` checkbox — NOT on Active Status and NOT on
  // operationality — so making the ranch routable cannot re-open it.
  assert.match(src, /export function isBrokerRailReferral\(ref: SlaReferralLike\): boolean \{/);
  assert.match(src, /if \(isBrokerRancher\(ref\.__rancher\)\) return true;/);
  assert.match(src, /if \(isBrokerRailReferral\(ref\)\) return false;/);
  assert.doesNotMatch(src, /isRancherOperationalForBuyers/);
});

// ---------------------------------------------------------------------------
// 4. SELF-SERVE ORDER PATHS — Connect-shaped, must not accept a broker ranch
// ---------------------------------------------------------------------------

test('GATE orders/request: refuses a represented ranch explicitly, not by a slug-lookup accident', () => {
  const src = read('../app/api/orders/request/route.ts');
  assert.match(src, /import \{ isBrokerRancher \} from '@\/lib\/brokerRail'/);
  assert.match(src, /if \(isBrokerRancher\(rancher\)\) \{/);
  const brokerIdx = src.indexOf('if (isBrokerRancher(rancher)) {');
  const opIdx = src.indexOf('if (!isRancherOperationalForBuyers(rancher)) {');
  assert.ok(brokerIdx > -1 && opIdx > brokerIdx, 'the rail refusal comes first');
  // The buyer is pointed at the match funnel, not dead-ended.
  assert.match(src.slice(brokerIdx, opIdx), /fallbackToMatch: true/);
});

// ---------------------------------------------------------------------------
// 5. CAMPAIGN WAVES — the send is CORRECT; the CTA had to change
// ---------------------------------------------------------------------------

test('CAMPAIGN: the broker CTA lands on the ranch\'s own reserve surface, not the Connect funnel', () => {
  const url = brokerReserveCta('AZ', 'dry-wash-cattle');
  assert.match(url, /\/ranchers\/dry-wash-cattle\?/);
  assert.match(url, /#reserve$/, 'the anchor must trail the query to survive as a fragment');
  assert.doesNotMatch(url, /\/access\?/, 'that is the CONNECT quiz funnel');
  assert.doesNotMatch(url, /\/r\/d\//, 'that is the CONNECT one-tap deposit rail');
});

test('CAMPAIGN: the broker CTA keeps the SAME utm triple so the funnel report still splits by campaign', () => {
  const utmOf = (u: string) => u.slice(u.indexOf('utm_source')).replace(/#.*$/, '');
  assert.equal(utmOf(brokerReserveCta('AZ', 's')), utmOf(requalifyCta('AZ', 's')));
});

test('CAMPAIGN: the broker email body carries the BROKER money model, never the Connect one', () => {
  const built = renderRequalifyEmail(
    'Alex R',
    'AZ',
    { name: 'Dry Wash Cattle', slug: 'dry-wash-cattle' },
    { mode: 'broker-reserve', url: brokerReserveCta('AZ', 'dry-wash-cattle') },
  );
  assert.match(built.html, /Reserve your share/);
  assert.match(built.html, /settle the balance straight with Dry Wash Cattle/);
  assert.doesNotMatch(built.html, /90 second quiz/, 'the broker CTA is not the quiz');
  // Copy contract: nothing about a fee, and nothing riding on top.
  const lower = built.html.toLowerCase();
  for (const forbidden of ['commission', 'on top', 'our fee', 'we keep']) {
    assert.ok(!lower.includes(forbidden), `broker campaign copy leaked "${forbidden}"`);
  }
});

test('CAMPAIGN: quiz and one-tap bodies are unchanged by the new mode', () => {
  const rancher = { name: 'Stone Fork Beef', slug: 'stone-fork-beef' };
  const quiz = renderRequalifyEmail('Alex R', 'MT', rancher, { mode: 'quiz', url: requalifyCta('MT', 'stone-fork-beef') });
  assert.match(quiz.html, /90 second quiz/);
  const oneTap = renderRequalifyEmail('Alex R', 'MT', rancher, {
    mode: 'one-tap', url: 'https://x.test/r/d/tok', cutLabel: 'Half Cow', dueNowDollars: 450,
  });
  assert.match(oneTap.html, /Reserve your half cow/);
});

test('CAMPAIGN wiring: a broker wave owner never mints a Connect one-tap deposit token', () => {
  const src = read('../app/api/campaign/requalify-send/route.ts');
  // getRancherBySlug still excludes broker ⇒ rancherRec stays null ⇒
  // decideRequalifyCta refuses one-tap. The broker detection is a SEPARATE
  // lookup that only redirects the CTA.
  assert.match(src, /brokerReserve = isBrokerRoutable\(await getRancherOrProspectBySlug\(rancher\.slug\)\)/);
  assert.match(src, /\? \{ mode: 'broker-reserve', url: brokerReserveCta\(r\.state, rancher\.slug\) \}/);
  const primaryIdx = src.indexOf('rancherRec = (await getRancherBySlug');
  const detectIdx = src.indexOf('let brokerReserve = false;');
  assert.ok(primaryIdx > -1 && detectIdx > primaryIdx, 'broker detection is a SECOND, later lookup');
  assert.match(src.slice(detectIdx, detectIdx + 300), /if \(!rancherRec\) \{/);
  // The primary resolver keeps its broker exclusion — that null is what makes
  // decideRequalifyCta refuse one-tap for a ranch with no Stripe account.
  assert.match(read('./airtable.ts'), /\{Page Live\} = 1, NOT\(\{Broker Rail\} = 1\)/);
});

// ---------------------------------------------------------------------------
// 6. THE POST-MATCH RAILS — a broker referral row is SHAPE-IDENTICAL to a
//    Connect lead (Status 'Intro Sent', `Rancher` set, 'Deposit Invite Sent
//    At' stamped), and every rail below keyed off exactly that shape. All five
//    consult the ONE predicate in lib/brokerDownstream; these pins fail if any
//    of them grows its own inline check again.
// ---------------------------------------------------------------------------

test('SHARED PREDICATE: every post-match gate consults lib/brokerDownstream, not a private copy', () => {
  const sites = [
    '../app/api/cron/referral-chasup/route.ts',
    '../app/api/cron/deposit-request-nudge/route.ts',
    '../app/api/member/content/route.ts',
    '../app/api/admin/referrals/[id]/resend-intro/route.ts',
    '../app/api/cron/email-sequences/route.ts',
    '../app/api/webhooks/telegram/route.ts',
  ];
  for (const rel of sites) {
    const src = read(rel);
    assert.match(src, /from '@\/lib\/brokerDownstream'/, `${rel} must consult the shared predicate`);
    // The drift this module exists to stop: a hand-rolled `Broker Rail` read.
    assert.doesNotMatch(src, /\['Broker Rail'\]/, `${rel} re-derived the rail inline`);
  }
});

test('GATE rancher lead digest: a represented ranch is never emailed the buyer\'s phone + email', () => {
  const src = read('../app/api/cron/referral-chasup/route.ts');
  assert.match(src, /import \{ railForLoadedRancher, referralCarriesBrokerMarker \} from '@\/lib\/brokerDownstream'/);
  assert.match(src, /refs\.some\(referralCarriesBrokerMarker\) \|\|\n\s*railForLoadedRancher\(rancher\) === 'broker'/);
  const gateIdx = src.indexOf("skipReasons['broker-rail']");
  assert.ok(gateIdx > -1, 'the skip must be counted, not silent');
  // Everything the digest would have done sits AFTER the refusal.
  assert.ok(src.indexOf('sendRancherLeadDigest', gateIdx) > gateIdx, 'the digest send must be gated');
  assert.ok(src.indexOf("'Lead Digest Sent At': stampNow", gateIdx) > gateIdx, 'no rancher-side write either');
  // It must NOT ride the Active Status list — a represented ranch's is BLANK
  // (app/api/partner/represent never writes it), so that check can never bite.
  const activeIdx = src.indexOf("['Paused', 'Non-Compliant', 'Removed'].includes(activeStatus)");
  assert.ok(activeIdx > gateIdx, 'the broker refusal must precede, and not depend on, Active Status');
});

test('GATE deposit-request-nudge: the rail is resolved fail-closed, and decides phone + destination', () => {
  const src = read('../app/api/cron/deposit-request-nudge/route.ts');
  assert.match(src, /from '@\/lib\/brokerDownstream'/);
  // Rail B's cohort formula is EXACTLY the post-broker-match state, so this
  // cron was armed by the routable-broker PR itself.
  assert.match(src, /const ABANDON_CANDIDATE_FORMULA =\n\s*`AND\(NOT\(\{Deposit Invite Sent At\}=""\), \{Deposit Requested At\}="", \{Deposit Paid At\}=""\)`/);
  assert.match(src, /const rail = await resolveReferralRail\(r, async \(rancherId\) => \{/);
  // The ranch's phone becomes an sms: link in the buyer's email — the leak.
  assert.match(src, /if \(rail !== 'broker'\) rancherPhone = String\(loadedRancher\['Phone'\]/);
  // And the CTA must point at a page that can actually take the money —
  // but only on AFFIRMATIVE broker evidence. `rail` fails closed to 'broker'
  // when the rancher read throws, and diverting a CONNECT buyer to the broker
  // checkout on an Airtable blip would refuse a payment we could have taken.
  assert.match(src, /const confirmedBroker =\n\s*referralCarriesBrokerMarker\(r\) \|\|\n\s*\(!!loadedRancher && railForLoadedRancher\(loadedRancher\) === 'broker'\);/);
  assert.match(src, /const depositPath = confirmedBroker \? `\/checkout\/\$\{r\.id\}\/broker` : `\/checkout\/\$\{r\.id\}\/deposit`;/);
  assert.match(src, /rail: confirmedBroker \? 'broker' : 'connect',/);
  // The SMS rescue leg rides the same rail decision (same read, no extra I/O).
  assert.match(src, /const smsDepositPath = smsRail === 'broker' \? `\/checkout\/\$\{r\.id\}\/broker`/);
});

test('GATE deposit nudge TEMPLATE: broker never renders an sms: link, even if a caller passes one', () => {
  const src = read('./emailMinimal.ts');
  assert.match(src, /const isBroker = opts\.rail === 'broker';/);
  assert.match(src, /const phoneLine = opts\.rancherPhone && !isBroker/);
  // "accepts your slot" is Connect machinery a represented ranch does not have.
  assert.match(src, /const refundLine = isBroker\n\s*\? `fully refundable until \$\{rancherFirst\} confirms your animal\.`/);
});

test('GATE /member: rancher email + phone are withheld on the broker rail until the deposit lands', () => {
  const src = read('../app/api/member/content/route.ts');
  assert.match(src, /const rail = referralCarriesBrokerMarker\(r\) \? 'broker' : railForLoadedRancher\(rr\);/);
  assert.match(src, /if \(mayRevealRancherContact\(r, rail\)\) \{/);
  const gateIdx = src.indexOf('if (mayRevealRancherContact(r, rail)) {');
  const closeIdx = src.indexOf('      }', gateIdx);
  const guarded = src.slice(gateIdx, closeIdx);
  // Everything that becomes a direct channel in RancherContactBlock.
  for (const field of ["rr['Email']", "rr['Phone']", "'Pickup Address'", "'Pickup Instructions'"]) {
    assert.ok(guarded.includes(field), `${field} must sit INSIDE the reveal gate`);
  }
  // The name/slug stay outside — the buyer must still see WHO they matched.
  const beforeGate = src.slice(src.indexOf('const rr: any = ranchersById.get(rancherId);'), gateIdx);
  assert.ok(beforeGate.includes("rr['Slug']"), 'the ranch page link is not contact details');
});

test('GATE admin resend-intro: refuses a represented ranch (the sibling reassign gate\'s twin)', () => {
  const src = read('../app/api/admin/referrals/[id]/resend-intro/route.ts');
  assert.match(src, /if \(referralCarriesBrokerMarker\(referral\) \|\| railForLoadedRancher\(rancher\) === 'broker'\) \{/);
  const gateIdx = src.indexOf("railForLoadedRancher(rancher) === 'broker'");
  // BOTH halves of the double intro sit after the refusal.
  assert.ok(src.indexOf('BuyHalfCow Introduction:', gateIdx) > gateIdx, 'rancher-side intro must be gated');
  assert.ok(src.indexOf('sendBuyerIntroNotification', gateIdx) > gateIdx, 'buyer-side intro must be gated');
  assert.ok(src.indexOf('rancherPhone:', gateIdx) > gateIdx);
  // The operator is pointed at the rail that DOES take money.
  assert.match(src, /redirectUrl: `\/checkout\/\$\{id\}\/broker`/);
});

test('GATE deposit page: a rail redirect from the GET is FOLLOWED, not rendered as an error', () => {
  const src = read('../app/checkout/[refId]/deposit/page.tsx');
  const getBranch = src.slice(src.indexOf("fetch(`/api/checkout/deposit?refId="), src.indexOf('const continueToCheckout'));
  assert.match(getBranch, /if \(j\.redirectUrl\) \{\n\s*window\.location\.href = String\(j\.redirectUrl\);\n\s*return;\n\s*\}/);
  // It must run BEFORE the generic error shell takes over.
  const redirIdx = getBranch.indexOf('if (j.redirectUrl) {');
  const errIdx = getBranch.indexOf('setErrCode(String(j.error));');
  assert.ok(redirIdx > -1 && errIdx > redirIdx, 'the redirect must pre-empt setErrCode');
  // And the server half must still hand one back for a broker referral.
  const api = read('../app/api/checkout/deposit/route.ts');
  assert.match(api, /error: 'not_connect_rail',\n\s*redirectUrl: `\/checkout\/\$\{referralId\}\/broker`/);
});

// ---------------------------------------------------------------------------
// 7. FAILURE-CONDITIONED TWINS — if the match's 'Intro Sent' write throws, the
//    broker row is left at 'Pending Approval', which is exactly what these
//    three promote paths hunt for. Same money outcome, so same gate.
// ---------------------------------------------------------------------------

test('GATE promote-PA: a stuck broker row is skipped, not promoted into a Connect double intro', () => {
  const src = read('../app/api/cron/email-sequences/route.ts');
  assert.match(src, /if \(referralCarriesBrokerMarker\(stuckRef\) \|\| railForLoadedRancher\(rancher\) === 'broker'\) \{/);
  const gateIdx = src.indexOf("railForLoadedRancher(rancher) === 'broker'");
  assert.ok(src.indexOf('sendBuyerIntroNotification', gateIdx) > gateIdx);
  assert.ok(src.indexOf("'Status': 'Intro Sent'", gateIdx) > gateIdx, 'no status write either');
});

test('GATE telegram /bulkfire + approve_: neither can mass-fire a Connect intro on the broker rail', () => {
  const src = read('../app/api/webhooks/telegram/route.ts');
  assert.match(src, /if \(referralCarriesBrokerMarker\(ref\) \|\| railForLoadedRancher\(rancher\) === 'broker'\) \{\n\s*brokerSkipped\+\+;/);
  assert.match(src, /Broker-rail skipped: \$\{brokerSkipped\}/, 'the skip is reported, never silent');
  assert.match(src, /if \(referralCarriesBrokerMarker\(referral\) \|\| railForLoadedRancher\(rancher\) === 'broker'\) \{/);
  const approveIdx = src.indexOf("referralCarriesBrokerMarker(referral) || railForLoadedRancher(rancher) === 'broker'");
  // The "10% commission on BHC referral sales" line — an agreement a
  // represented ranch never signed — sits after the refusal.
  assert.ok(src.indexOf('10% commission on BHC referral sales', approveIdx) > approveIdx);
});

// ---------------------------------------------------------------------------
// 8. THE MATCH GATE'S OWN CONTRACT — the doc comment used to promise a
//    fail-closed that the code did not implement.
// ---------------------------------------------------------------------------

test('planMatchNotifications: an UNREADABLE rancher gets the broker plan, as documented', async () => {
  const { planMatchNotifications } = await import('./brokerMatch');
  for (const bad of [null, undefined, 'recSomething', 0]) {
    const plan = planMatchNotifications(bad as any);
    assert.equal(plan.rail, 'broker', `a ${typeof bad} rancher must fail closed`);
    assert.equal(plan.rancherLeadEmail, false);
    assert.equal(plan.buyerIntroHandoff, false);
    assert.equal(plan.expectACallSms, false);
  }
  // A REAL row with no `Broker Rail` key is the normal Connect wire shape
  // (Airtable omits unchecked checkboxes) — it must stay Connect, or the whole
  // platform silently converts to the broker plan.
  assert.equal(planMatchNotifications({ id: 'recX', 'Ranch Name': 'R' }).rail, 'connect');
  assert.equal(planMatchNotifications({ id: 'recX', 'Broker Rail': true }).rail, 'broker');
});
