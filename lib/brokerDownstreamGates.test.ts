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
