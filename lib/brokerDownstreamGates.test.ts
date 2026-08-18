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
  assert.ok(src.indexOf('commission on BHC referral sales', gateIdx) > gateIdx, 'wrong money model');
  assert.ok(src.indexOf('BuyHalfCow Introduction:', gateIdx) > gateIdx);
});

test('TIER TRUTH bulkRoute: the intro footer derives the rate from the loaded rancher, framing kept', () => {
  const src = read('./bulkRoute.ts');
  // Legacy commission-on-sales framing STAYS (this router is Connect/legacy
  // only — the broker gate above refuses first); only the tier-blind 10%
  // literal dies. A Pasture rancher reads 7%, Ranch 3%, a locked rate wins,
  // and a genuinely legacy/no-tier rancher still reads 10% via the derivation.
  assert.match(src, /\$\{commissionPercentLabelForRancher\(rancher\)\} commission on BHC referral sales\./);
  assert.doesNotMatch(src, /10% commission/, 'a tier-blind 10% footer came back');
});

test('GATE admin reassign: refuses a represented ranch as a reassign target', () => {
  const src = read('../app/api/admin/referrals/[id]/reassign/route.ts');
  assert.match(src, /import \{ isBrokerRancher \} from '@\/lib\/brokerRail'/);
  assert.match(src, /if \(isBrokerRancher\(newRancher\)\) \{/);
  const gateIdx = src.indexOf('if (isBrokerRancher(newRancher)) {');
  // The intro this blocks claims the buyer-pays-on-top model — false on a rail
  // where the ranch nets price − deposit and nothing is added on top.
  assert.ok(src.indexOf('is added on top and paid by the buyer', gateIdx) > gateIdx);
});

test('TIER TRUTH admin reassign: the added-on-top footer derives the rate from the target rancher', () => {
  const src = read('../app/api/admin/referrals/[id]/reassign/route.ts');
  // tier_v2 added-on-top framing STAYS (it is the truth of the deposit rail);
  // only the rate number derives — "our 10%" was flatly false for a Pasture
  // (7%) or Ranch (3%) target. Same derivation as the charge path, so the
  // footer can never quote a rate the deposit fee would contradict.
  assert.match(
    src,
    /our \$\{commissionPercentLabelForRancher\(newRancher\)\} is added on top and paid by the buyer\./,
  );
  assert.doesNotMatch(src, /our 10% is added on top/, 'the tier-blind 10% footer came back');
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
    // Comms containment wave (2026-08-18) — the rails the #628 sweep missed.
    '../app/api/cron/buyer-pulse/route.ts',
    '../app/api/cron/rancher-launch-warmup/route.ts',
    '../app/api/cron/qualified-no-action/route.ts',
    '../app/api/rancher/quick-action/route.ts',
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
  assert.match(src, /import \{ railForLoadedRancher, referralCarriesBrokerMarker, rancherIdForReferral \} from '@\/lib\/brokerDownstream'/);
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
  // The commission-footer line — an agreement a represented ranch never
  // signed — sits after the refusal. (Rate now DERIVED per rancher — see the
  // TIER TRUTH pin in section 9.)
  assert.ok(src.indexOf('commission on BHC referral sales', approveIdx) > approveIdx);
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

// ---------------------------------------------------------------------------
// 9. COMMS CONTAINMENT WAVE (2026-08-18) — the rails the #628 sweep missed.
//    Two are timed: live broker referrals with Intro Sent 08-18 enter the
//    stalled pool ~08-21 and the day-14 window ~09-01. Same convention as
//    section 6: source pins, and every gate consults lib/brokerDownstream.
// ---------------------------------------------------------------------------

test('GATE chasup stalled-nudge pool: a broker row never becomes a "Nudge Rancher" card', () => {
  const src = read('../app/api/cron/referral-chasup/route.ts');
  // The rancher prefetch keeps FULL records so every pool can consult the
  // shared predicate without a per-row read…
  assert.match(src, /const rancherRecordById = new Map<string, any>\(\);/);
  assert.match(src, /rancherRecordById\.set\(r\.id, r\);/);
  // …through the ONE referral-level helper (marker first, then the loaded row;
  // fail-closed — an unlinked referral or missing prefetch row reads broker).
  assert.match(
    src,
    /const isBrokerRailReferral = \(referral: any\): boolean =>\n\s*referralCarriesBrokerMarker\(referral\) \|\|\n\s*railForLoadedRancher\(rancherRecordById\.get\(rancherIdForReferral\(referral\)\)\) === 'broker';/,
  );
  const poolIdx = src.indexOf('const stalledForNudge = introSentRefs.filter');
  assert.ok(poolIdx > -1);
  const gateIdx = src.indexOf('if (isBrokerRailReferral(r)) {', poolIdx);
  const cardIdx = src.indexOf('nudgerancher_', poolIdx);
  assert.ok(gateIdx > -1 && cardIdx > gateIdx, 'the pool gate must precede the Telegram card mint');
});

test('GATE chasup day-14 stale prompt: a represented ranch never gets the 4-button quick-action email', () => {
  const src = read('../app/api/cron/referral-chasup/route.ts');
  const loopIdx = src.indexOf('if (daysSince >= STALE_PROMPT_DAYS) {');
  assert.ok(loopIdx > -1);
  // The gate rides the rancher row this loop already loads at eligibility time.
  const gateIdx = src.indexOf(
    "if (referralCarriesBrokerMarker(ref) || railForLoadedRancher(r) === 'broker') {",
    loopIdx,
  );
  assert.ok(gateIdx > loopIdx, 'the broker gate must sit on the loaded rancher row');
  // The push — and with it the email whose quick-action buttons let the ranch
  // FLIP the row — sits after the refusal.
  assert.ok(src.indexOf('promptedRanchers.push', gateIdx) > gateIdx);
});

test('GATE chasup buyer AI chase: the broker skip is EXPLICIT, not the blank-Active-Status accident', () => {
  const src = read('../app/api/cron/referral-chasup/route.ts');
  const staleIdx = src.indexOf('const stale = referrals.filter');
  assert.ok(staleIdx > -1);
  const gateIdx = src.indexOf('if (isBrokerRailReferral(r)) {', staleIdx);
  const pausedIdx = src.indexOf('if (isRancherPaused(r)) {', staleIdx);
  assert.ok(
    gateIdx > staleIdx && pausedIdx > gateIdx,
    'the explicit broker skip must precede (and not depend on) the paused-status accident',
  );
});

test('GATE telegram nudgerancher: the callback #628 missed refuses exactly like approve_ does', () => {
  const src = read('../app/api/webhooks/telegram/route.ts');
  const branchIdx = src.indexOf("else if (action === 'nudgerancher') {");
  assert.ok(branchIdx > -1);
  const gateIdx = src.indexOf(
    "if (referralCarriesBrokerMarker(ref) || railForLoadedRancher(rancher) === 'broker') {",
    branchIdx,
  );
  const nextBranchIdx = src.indexOf("else if (action === 'closelost')", branchIdx);
  assert.ok(gateIdx > branchIdx && gateIdx < nextBranchIdx, 'the refusal must live inside the nudgerancher branch');
  assert.match(src.slice(gateIdx, gateIdx + 700), /Represented ranch — send the deposit link instead\./);
  // The buyer email+phone block it exists to stop sits after the refusal.
  const leakIdx = src.indexOf('Buyer details:', gateIdx);
  assert.ok(leakIdx > gateIdx && leakIdx < nextBranchIdx, 'the contact block must be downstream of the refusal');
});

test('GATE quick-action: a broker-rail link refuses before ANY write (30d tokens outlive the pool gates)', () => {
  const src = read('../app/api/rancher/quick-action/route.ts');
  const gateIdx = src.indexOf(
    "if (referralCarriesBrokerMarker(referral) || railForLoadedRancher(rancherForRail) === 'broker') {",
  );
  assert.ok(gateIdx > -1);
  // Fail-closed loader: an unreadable rancher refuses rather than proceeds.
  assert.match(src, /rancherForRail = null; \/\/ railForLoadedRancher\(null\) → 'broker' \(fail closed\)/);
  // No mutation may precede the refusal — not the money lock, not the
  // activity stamp, nothing.
  const firstWriteIdx = src.indexOf('await updateRecord(');
  const moneyLockIdx = src.indexOf('isDepositLocked(referral');
  assert.ok(moneyLockIdx > gateIdx, 'rail identity precedes state locks');
  assert.ok(firstWriteIdx > gateIdx, 'no write may precede the refusal');
});

test('GATE buyer-pulse: "did your rancher reach out?" never goes to a broker-matched buyer', () => {
  const src = read('../app/api/cron/buyer-pulse/route.ts');
  assert.match(
    src,
    /import \{ railForLoadedRancher, referralCarriesBrokerMarker, rancherIdForReferral \} from '@\/lib\/brokerDownstream'/,
  );
  assert.match(
    src,
    /referralCarriesBrokerMarker\(r\) \|\|\n\s*railForLoadedRancher\(ranchersById\.get\(rancherIdForReferral\(r\)\)\) === 'broker'/,
  );
  const gateIdx = src.indexOf('brokerSkipped++;');
  assert.ok(gateIdx > -1, 'the skip must be counted, not silent');
  // The pulse send — and the "ghosted" tap that triggers Connect-shaped
  // remediation — sit after the pool gate.
  assert.ok(src.indexOf("mkToken('ghosted')", gateIdx) > gateIdx);
  assert.ok(src.indexOf('buyer_pulse_check_in', gateIdx) > gateIdx);
});

test('GATE launch warmup: broker ranches route to the deposit-first template, never the contact-info promise', () => {
  const route = read('../app/api/cron/rancher-launch-warmup/route.ts');
  assert.match(route, /from '@\/lib\/brokerDownstream'/);
  // Both Phase-1 send sites pass the rail of the rancher row they already hold.
  assert.equal(route.split('await sendRancherLaunchWarmup({').length - 1, 2, 'both Phase-1 send sites exist');
  assert.equal(route.split('rail: railForLoadedRancher(rancher),').length - 1, 2, 'both send sites pass the rail');
  // Phase-2 nudge diverts copy on AFFIRMATIVE evidence only (a missing
  // activeRancher names no ranch, so the generic Connect copy stays).
  assert.match(route, /activeRancher && railForLoadedRancher\(activeRancher\) === 'broker' \? 'broker' : 'connect'/);

  const email = read('./email.ts');
  // The rail flags derive from the caller's rail — never a constant.
  assert.match(email, /const isBroker = data\.rail === 'broker';/);
  assert.match(email, /const isBrokerNudge = data\.rail === 'broker';/);
  // Broker variant: deposit-first, pickup-after. Connect promise byte-identical.
  assert.match(
    email,
    /const promiseLine = isBroker\n\s*\? `If yes, click below — I'll send you a reserve link right after\. A deposit locks your share, and pickup details follow once your animal is confirmed\.`/,
  );
  assert.match(
    email,
    /: `If yes, click below — I'll send the rancher's full info \(pricing, processing date, contact\) right after, and they'll reach out to you directly within 24–48 hours\.`/,
  );
  // COPY CONTRACT: buyer copy never frames the deposit as a commission or fee.
  const warmupSlice = email.slice(
    email.indexOf('export async function sendRancherLaunchWarmup'),
    email.indexOf('export async function sendRancherLeadDigest'),
  );
  for (const forbidden of ['commission', 'our fee', 'we keep']) {
    assert.ok(!warmupSlice.toLowerCase().includes(forbidden), `warmup copy leaked "${forbidden}"`);
  }
});

test('GATE deposit-request-nudge rail C: the broker leg chases the deposit instead of dropping it hourly forever', () => {
  const src = read('../app/api/cron/deposit-request-nudge/route.ts');
  // Same two-bar design as the rail-A/B loop, now inside resolveContext:
  // divert on AFFIRMATIVE evidence, refuse-to-proceed when the rancher is
  // unreadable (a marker row with no loaded rancher waits for the next run
  // rather than mailing a link into the broker route's 503).
  assert.match(
    src,
    /const confirmedBroker =\n\s*referralCarriesBrokerMarker\(r\) \|\|\n\s*\(!!rancher && railForLoadedRancher\(rancher\) === 'broker'\);/,
  );
  assert.match(src, /if \(confirmedBroker && !rancher\) return null;/);
  // The Connect-only gate now applies ONLY to the connect leg…
  assert.match(
    src,
    /if \(!confirmedBroker\) \{\n\s*if \(!rancher \|\| !isRancherOperationalForBuyers\(rancher\) \|\| !isRancherOnConnect\(rancher\)\) return null;\n\s*\}/,
  );
  // …and the CTA points at the checkout that can actually take the money.
  assert.match(
    src,
    /const reservePath = confirmedBroker \? `\/checkout\/\$\{r\.id\}\/broker` : `\/checkout\/\$\{r\.id\}\/deposit`;/,
  );
});

test('GATE deposit-request-nudge: a suppressed buyer\'s row is retired, not re-selected hourly forever', async () => {
  const src = read('../app/api/cron/deposit-request-nudge/route.ts');
  // Rail A/B email loop: one terminal write (sentinel count + last-sent +
  // cross-rail SMS stamp) on the suppressed path.
  assert.match(src, /'Deposit Nudge Count': DEPOSIT_NUDGE_SUPPRESSED_SENTINEL,/);
  // SMS-rescue + rail C suppressed paths stamp their own one-shots too.
  const rescueIdx = src.indexOf('async function runDepositSmsRescue');
  const rescueSlice = src.slice(rescueIdx, src.indexOf('async function realHandler'));
  assert.match(rescueSlice, /\[DEPOSIT_SMS_SENT_FIELD\]: new Date\(nowMs\)\.toISOString\(\)/);
  const railCIdx = src.indexOf('async function runReserveAbandonRail');
  const railCSlice = src.slice(railCIdx, rescueIdx);
  assert.match(railCSlice, /\[RESERVE_RECOVERY_EMAIL_FIELD\]: suppressedStamp/);
  assert.match(railCSlice, /\[RESERVE_RECOVERY_SMS_FIELD\]: suppressedStamp/);

  // BEHAVIOR: the sentinel write retires the row from BOTH nudge rails and the
  // SMS leg — pure selectors, no Airtable.
  const {
    isDepositNudgeEligible,
    isDepositAbandonEligible,
    isDepositSmsRescueEligible,
    DEPOSIT_NUDGE_SUPPRESSED_SENTINEL,
    DEPOSIT_SMS_SENT_FIELD,
  } = await import('./depositRequestNudge');
  assert.equal(DEPOSIT_NUDGE_SUPPRESSED_SENTINEL, 99);
  const now = Date.now();
  const days = (n: number) => new Date(now - n * 24 * 3600e3).toISOString();
  const suppressedWrite = {
    'Deposit Nudge Last Sent At': days(3),
    'Deposit Nudge Count': DEPOSIT_NUDGE_SUPPRESSED_SENTINEL,
    [DEPOSIT_SMS_SENT_FIELD]: days(3),
  };
  const railA = { 'Deposit Requested At': days(5), 'Deposit Paid At': '', Status: 'Awaiting Payment', ...suppressedWrite };
  assert.equal(isDepositNudgeEligible(railA, now), false, 'rail A must be retired');
  assert.equal(isDepositSmsRescueEligible(railA, now), false, 'SMS leg must be retired');
  const railB = { 'Deposit Invite Sent At': days(5), 'Deposit Requested At': '', 'Deposit Paid At': '', Status: 'Intro Sent', ...suppressedWrite };
  assert.equal(isDepositAbandonEligible(railB, now), false, 'rail B must be retired');
});

test('GATE qualified-no-action: a confirmed-broker buyer is sent to the broker checkout, not a dead-end /member', () => {
  const src = read('../app/api/cron/qualified-no-action/route.ts');
  assert.match(
    src,
    /const confirmedBroker =\n\s*referralCarriesBrokerMarker\(ref\) \|\|\n\s*\(!!rancher && railForLoadedRancher\(rancher\) === 'broker'\);/,
  );
  assert.match(src, /confirmedBroker\n\s*\? buildNudgeMagicLink\(buyerId, email, `\/checkout\/\$\{ref\.id\}\/broker`\)/);
  assert.match(
    src,
    /const ctaLabel = confirmedBroker \? 'Reserve your share' : depositCapable \? 'Reserve your slot' : 'View your match';/,
  );
});

test('GATE qualified-no-action: a marker row whose rancher would not load WAITS, exactly like rail C', () => {
  const src = read('../app/api/cron/qualified-no-action/route.ts');
  // Evidence-bar parity with deposit-request-nudge's resolveContext
  // (confirmedBroker && !rancher → null): a marker-carrying row whose rancher
  // read failed must SKIP THIS RUN, not send the buyer into the broker
  // checkout's fail-closed refusal — the per-referral dedup stamp means a
  // buyer bounced off that refusal never gets a retry.
  const waitIdx = src.indexOf('if (confirmedBroker && !rancher) {');
  assert.ok(waitIdx > -1, 'the wait gate must exist');
  assert.match(src, /if \(confirmedBroker && !rancher\) \{\n\s*brokerWaits\+\+;\n\s*continue;\n\s*\}/);
  // The wait must sit BEFORE the claim stamp — a skipped buyer stays eligible
  // for the next hourly run inside the 4h window.
  const claimIdx = src.indexOf('await updateRecord(TABLES.CONSUMERS, buyerId', waitIdx);
  assert.ok(claimIdx > waitIdx, 'the wait must precede the dedup claim stamp');
  // And it is counted, never silent.
  assert.match(src, /brokerWaits=\$\{brokerWaits\}/);
});

test('TIER TRUTH: telegram rancher-email footers derive the commission rate from the loaded rancher', () => {
  const src = read('../app/api/webhooks/telegram/route.ts');
  // Both footers (approve_ intro + nudgerancher) derive; the tier-blind 10%
  // literal is dead. A genuinely legacy/no-tier rancher still renders "10%"
  // (env default) — via the derivation, never a literal.
  assert.equal(
    src.split('commissionPercentLabelForRancher(rancher)').length - 1,
    2,
    'both footers must derive from the loaded rancher',
  );
  assert.doesNotMatch(src, /10% commission/, 'a tier-blind 10% footer came back');
});
