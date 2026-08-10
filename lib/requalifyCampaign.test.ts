import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderRequalifyEmail,
  validateRequalifyBatch,
  requalifyCta,
  requalifyOneTapCta,
  requalifyUtm,
  orderTypeToCut,
  pickCanonicalConsumer,
  blocksOneTapDeposit,
  decideRequalifyCta,
  MAX_BATCH,
  DAILY_CAMPAIGN_BUDGET,
} from './requalifyCampaign';
import { isActiveDealReferral } from './capacityCount';

const CV = { name: 'Champion Valley Farm', slug: 'champion-valley-farm' };

test('render: subject + body carry first name, state, CV pin; no banned money framing', () => {
  const r = renderRequalifyEmail('Jane Doe', 'CO', CV);
  assert.match(r.subject, /^Jane, /);
  assert.match(r.html, /serving CO/);
  assert.match(r.html, /rancher=champion-valley-farm/);
  assert.match(r.html, /utm_campaign=waiting-wake-co/);
  for (const banned of ['deduct', 'keep 90', 'we take']) assert.ok(!r.html.toLowerCase().includes(banned), banned);
});

test('render: blank name → "there"; junk state degrades gracefully', () => {
  const r = renderRequalifyEmail('', 'Colorado', CV);
  assert.match(r.subject, /^there, /);
  assert.match(r.html, /your state/);
  assert.match(requalifyCta('Colorado', CV.slug), /waiting-wake-xx/);
});

// ── subject variants (ADAPTIVE-MARKETING-DESIGN PR 1) ──────────────────────

test('render: default/A variant subject is byte-identical to the historical subject', () => {
  const plain = renderRequalifyEmail('Jane Doe', 'CO', CV);
  const explicitA = renderRequalifyEmail('Jane Doe', 'CO', CV, undefined, 'A');
  assert.equal(plain.subject, `Jane, there's a ranch for you now`);
  assert.equal(explicitA.subject, plain.subject);
});

test('render: variant B changes ONLY the subject — body identical across arms', () => {
  const a = renderRequalifyEmail('Jane Doe', 'CO', CV, undefined, 'A');
  const b = renderRequalifyEmail('Jane Doe', 'CO', CV, undefined, 'B');
  assert.notEqual(a.subject, b.subject);
  assert.equal(a.html, b.html, 'variants are a SUBJECT experiment only');
  // One-tap mode too: variant must not touch the money copy.
  const cta = { mode: 'one-tap' as const, url: 'https://x/r/d/t', cutLabel: 'Half Cow', dueNowDollars: 375 };
  const oa = renderRequalifyEmail('Jane Doe', 'CO', CV, cta, 'A');
  const ob = renderRequalifyEmail('Jane Doe', 'CO', CV, cta, 'B');
  assert.equal(oa.html, ob.html);
  assert.notEqual(oa.subject, ob.subject);
});

test('validate: strict shape — batch cap, email format, campaign slug', () => {
  const good = { campaign: 'cv-requalify', rancher: CV, recipients: [{ email: 'A@B.co', name: 'A', state: 'NE' }] };
  const ok = validateRequalifyBatch(good);
  assert.ok(!('error' in ok) && ok.recipients[0].email === 'a@b.co');
  assert.ok('error' in validateRequalifyBatch({ campaign: 'cv-requalify', rancher: CV, recipients: [] }));
  // rancher is REQUIRED and slug-validated — the endpoint is per-rancher now
  assert.ok('error' in validateRequalifyBatch({ campaign: 'cv-requalify', recipients: good.recipients }));
  assert.ok('error' in validateRequalifyBatch({ campaign: 'cv-requalify', rancher: { name: 'X Ranch', slug: 'Bad Slug!' }, recipients: good.recipients }));
  assert.ok('error' in validateRequalifyBatch({ campaign: 'BAD SLUG', rancher: CV, recipients: good.recipients }));
  assert.ok('error' in validateRequalifyBatch({ campaign: 'cv-requalify', rancher: CV, recipients: [{ email: 'nope' }] }));
  const over = { campaign: 'cv-requalify', rancher: CV, recipients: Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ email: `a${i}@b.co`, name: 'x', state: 'CO' })) };
  assert.ok('error' in validateRequalifyBatch(over));
});

test('daily budget constant is a sane domain-wide ceiling', () => {
  assert.ok(DAILY_CAMPAIGN_BUDGET >= 100 && DAILY_CAMPAIGN_BUDGET <= 150);
});

// ── one-tap deposit CTA ────────────────────────────────────────────────────

/** A rancher that clears every deposit gate: Connect active, operational,
 *  valid tier, half priced well above MIN_TIER_PRICE. */
const payableRancher = (over: Record<string, any> = {}) => ({
  id: 'recRANCHER0000001',
  'Ranch Name': 'Champion Valley Farm',
  Slug: CV.slug,
  State: 'CO',
  'Pricing Model': 'tier_v2',
  'Stripe Connect Status': 'active',
  'Active Status': 'Active',
  'Onboarding Status': 'Live',
  'Agreement Signed': true,
  Tier: 'pasture',
  'Quarter Price': 1400,
  'Half Price': 2600,
  'Whole Price': 4800,
  ...over,
});

const buyer = (over: Record<string, any> = {}) => ({
  id: 'recBUYER000000001',
  Email: 'jane@example.com',
  'Order Type': 'Half',
  State: 'CO',
  ...over,
});

const decide = (over: Record<string, any> = {}) =>
  decideRequalifyCta({
    consumers: [buyer()],
    rancher: payableRancher(),
    buyerReferrals: [],
    servedStates: null,
    commissionRate: 0.07,
    ...over,
  });

test('orderTypeToCut: quiz values, reserve labels, opt-outs and junk', () => {
  assert.equal(orderTypeToCut('Half'), 'half');
  assert.equal(orderTypeToCut('Half Cow'), 'half');
  assert.equal(orderTypeToCut('  QUARTER cow '), 'quarter');
  assert.equal(orderTypeToCut('Whole Cow (~440 lbs)'), 'whole');
  assert.equal(orderTypeToCut({ name: 'Whole' }), 'whole'); // Airtable select object shape
  assert.equal(orderTypeToCut('Not Sure'), null);
  assert.equal(orderTypeToCut('Not specified'), null);
  assert.equal(orderTypeToCut(''), null);
  assert.equal(orderTypeToCut(null), null);
  assert.equal(orderTypeToCut('1/2 cow'), null);
});

test('pickCanonicalConsumer: exactly one row wins, ANY duplicate is ambiguous', () => {
  assert.deepEqual(pickCanonicalConsumer([]), { consumer: null, ambiguous: false });
  assert.deepEqual(pickCanonicalConsumer(null), { consumer: null, ambiguous: false });
  // rows without a record id are not identities
  assert.deepEqual(pickCanonicalConsumer([{ Email: 'a@b.co' }]), { consumer: null, ambiguous: false });

  const one = pickCanonicalConsumer([buyer()]);
  assert.equal(one.consumer?.id, 'recBUYER000000001');
  assert.equal(one.ambiguous, false);

  // TWO rows is ambiguous even when one is obviously newer. We cannot see which
  // row the buyer's member cookie names, and resolveDepositAuth gives that
  // session precedence over our grant — pick the other one and the deposit page
  // 403s. No recency rule can prove the pick, so we never guess.
  const dupe = pickCanonicalConsumer([
    buyer({ id: 'recOLD00000000001', _createdTime: '2024-01-01T00:00:00Z' }),
    buyer({ id: 'recNEW00000000001', _createdTime: '2026-01-01T00:00:00Z' }),
  ]);
  assert.equal(dupe.consumer, null);
  assert.equal(dupe.ambiguous, true);
});

test('decision matrix: happy path one-taps with the exact all-in number', () => {
  const d = decide();
  assert.equal(d.mode, 'one-tap');
  if (d.mode !== 'one-tap') return;
  assert.equal(d.consumerId, 'recBUYER000000001');
  assert.equal(d.cut, 'half');
  assert.equal(d.cutLabel, 'Half Cow');
  // deposit = 25% of 2600 = 650; fee = 7% of 2600 = 182; buyer sees ONE number.
  assert.equal(d.dueNowDollars, 832);
});

test('decision matrix: no consumer / duplicate rows → quiz', () => {
  assert.deepEqual(decide({ consumers: [] }), { mode: 'quiz', reason: 'no-consumer' });
  assert.deepEqual(
    decide({
      consumers: [buyer({ id: 'recA0000000000001' }), buyer({ id: 'recB0000000000001' })],
    }),
    { mode: 'quiz', reason: 'ambiguous-consumer' },
  );
});

test('decision matrix: no usable cut → quiz', () => {
  assert.deepEqual(decide({ consumers: [buyer({ 'Order Type': 'Not Sure' })] }), { mode: 'quiz', reason: 'no-cut' });
  assert.deepEqual(decide({ consumers: [buyer({ 'Order Type': '' })] }), { mode: 'quiz', reason: 'no-cut' });
});

test('decision matrix: cut unpriced (or below the online-deposit floor) → quiz', () => {
  assert.deepEqual(decide({ rancher: payableRancher({ 'Half Price': 0 }) }), { mode: 'quiz', reason: 'cut-unpriced' });
  assert.deepEqual(decide({ rancher: payableRancher({ 'Half Price': 40 }) }), { mode: 'quiz', reason: 'cut-unpriced' });
  // a per-lb style mis-entry on a DIFFERENT cut must not block this buyer
  assert.equal(decide({ rancher: payableRancher({ 'Whole Price': 7 }) }).mode, 'one-tap');
});

test('decision matrix: rancher not deposit-ready → quiz (never a bouncing link)', () => {
  const cases: Array<[string, Record<string, any>]> = [
    ['not on Connect', { 'Stripe Connect Status': 'onboarding' }],
    ['legacy pricing model', { 'Pricing Model': 'legacy' }],
    ['paused', { 'Active Status': 'Paused' }],
    ['agreement unsigned', { 'Agreement Signed': false }],
    ['mid onboarding', { 'Onboarding Status': 'Docs Sent' }],
    ['subscription past due', { 'Subscription Status': 'past_due' }],
    ['no tier', { Tier: '' }],
    ['closed account', { 'Verification Status': 'Removed' }],
  ];
  for (const [label, over] of cases) {
    assert.deepEqual(decide({ rancher: payableRancher(over) }), { mode: 'quiz', reason: 'rancher-ineligible' }, label);
  }
  assert.deepEqual(decide({ rancher: null }), { mode: 'quiz', reason: 'rancher-ineligible' });
});

test('decision matrix: buyer state outside the served set → quiz', () => {
  assert.equal(decide({ servedStates: ['CO', 'NE'] }).mode, 'one-tap');
  assert.deepEqual(decide({ servedStates: ['TX'] }), { mode: 'quiz', reason: 'state-not-served' });
  // full state name still normalizes
  assert.equal(decide({ consumers: [buyer({ State: 'Colorado' })], servedStates: ['CO'] }).mode, 'one-tap');
  // blank state cannot prove coverage for a regional rancher
  assert.deepEqual(decide({ consumers: [buyer({ State: '' })], servedStates: ['CO'] }), {
    mode: 'quiz',
    reason: 'state-not-served',
  });
  // null = nationwide pair, no gate
  assert.equal(decide({ consumers: [buyer({ State: '' })], servedStates: null }).mode, 'one-tap');
});

test('decision matrix: an active deal blocks a second deposit link', () => {
  for (const status of ['Intro Sent', 'Rancher Contacted', 'Negotiation', 'Awaiting Payment', 'Slot Locked']) {
    assert.deepEqual(
      decide({ buyerReferrals: [{ Status: status }] }),
      { mode: 'quiz', reason: 'active-referral' },
      status,
    );
  }
  // Pending Approval WITH a rancher attached is a live deal; an orphan is not.
  assert.deepEqual(decide({ buyerReferrals: [{ Status: 'Pending Approval', Rancher: ['recX'] }] }), {
    mode: 'quiz',
    reason: 'active-referral',
  });
  assert.equal(decide({ buyerReferrals: [{ Status: 'Pending Approval' }] }).mode, 'one-tap');
  // terminal history never blocks
  assert.equal(decide({ buyerReferrals: [{ Status: 'Closed Lost' }, { Status: 'Dormant' }] }).mode, 'one-tap');
});

test('blocksOneTapDeposit: catches an UNPAID deposit intent that isActiveDealReferral misses', () => {
  // A deposit-intent referral is born 'Pending' (buildReserveReferralFields) —
  // not a held status, so the capacity predicate says "not active". Stacking a
  // second one-tap on it gives the buyer two live payable reservations.
  const openIntent = { Status: 'Pending', 'Match Type': 'Direct (Rancher Page) — Deposit' };
  assert.equal(isActiveDealReferral(openIntent), false, 'precondition: the canonical predicate misses it');
  assert.equal(blocksOneTapDeposit(openIntent), true);
  assert.deepEqual(decide({ buyerReferrals: [openIntent] }), { mode: 'quiz', reason: 'active-referral' });

  // A SETTLED or dead deposit intent is not a collision — repeat customers and
  // lost deals must still get a one-tap link.
  for (const Status of ['Closed Won', 'Closed Lost', 'Dormant', 'Refunded']) {
    const ref = { Status, 'Match Type': 'Direct (Rancher Page) — Deposit' };
    assert.equal(blocksOneTapDeposit(ref), false, Status);
    assert.equal(decide({ buyerReferrals: [ref] }).mode, 'one-tap', Status);
  }
  // A plain 'Pending' lead with no deposit Match Type is not a payable hold.
  assert.equal(blocksOneTapDeposit({ Status: 'Pending' }), false);
});

test('decision matrix: exclusive ZIP territory gates the link (fails closed on a blank ZIP)', () => {
  const gated = (over: Record<string, any> = {}) => payableRancher({ 'Service ZIP Prefixes': '770, 787', ...over });
  // in territory
  assert.equal(decide({ rancher: gated(), consumers: [buyer({ Zip: '77002' })] }).mode, 'one-tap');
  // out of territory
  assert.deepEqual(decide({ rancher: gated(), consumers: [buyer({ Zip: '80202' })] }), {
    mode: 'quiz',
    reason: 'zip-not-served',
  });
  // unknown ZIP + a gated rancher = FAIL CLOSED, exactly like the deposit route
  assert.deepEqual(decide({ rancher: gated(), consumers: [buyer({ Zip: '' })] }), {
    mode: 'quiz',
    reason: 'zip-not-served',
  });
  // no territory configured → the gate is a no-op, a ZIP-less buyer still one-taps
  assert.equal(decide({ consumers: [buyer({ Zip: '' })] }).mode, 'one-tap');
});

test('decision matrix: the quoted dollar never lands BELOW what the card is charged', () => {
  // deposit 650.00 + fee 259.10 = $909.10 charged. Rounding to 909 would quote
  // under the charge; ceil keeps the promise honest.
  const d = decide({ rancher: payableRancher({ 'Half Price': 2591 }), commissionRate: 0.1 });
  assert.equal(d.mode, 'one-tap');
  if (d.mode !== 'one-tap') return;
  assert.equal(d.dueNowDollars, 910);
});

test('decision matrix: price math that yields nothing is never emailed', () => {
  // Priced above the floor (passes the gate) but not a finite number the
  // display helper can quote.
  assert.deepEqual(decide({ rancher: payableRancher({ 'Half Price': 2600 }), commissionRate: NaN }), {
    mode: 'quiz',
    reason: 'no-price-math',
  });
});

test('one-tap render: names the cut + one all-in number, keeps utm, no fee itemization', () => {
  const r = renderRequalifyEmail('Jane Doe', 'CO', CV, {
    mode: 'one-tap',
    url: requalifyOneTapCta('CO', 'tok123'),
    cutLabel: 'Half Cow',
    dueNowDollars: 832,
  });
  assert.match(r.subject, /^Jane, /);
  assert.match(r.html, /Reserve your half cow/);
  assert.match(r.html, /\$832 today/);
  assert.match(r.html, /\/r\/d\/tok123/);
  assert.match(r.html, /utm_campaign=waiting-wake-co/);
  // never the quiz wall
  assert.ok(!r.html.includes('/access?'), 'one-tap body must not link the quiz');
  assert.ok(!/quiz/i.test(r.html), 'one-tap body must not mention the quiz');
  // money model: rancher keeps 100%, and the fee is never itemized buyer-side
  assert.match(r.html, /every dollar of the beef price goes to them/);
  for (const banned of ['deduct', 'keep 90', 'we take', 'commission', 'platform fee', 'service fee']) {
    assert.ok(!r.html.toLowerCase().includes(banned), banned);
  }
  // large amounts read as money
  const big = renderRequalifyEmail('Jane', 'CO', CV, { mode: 'one-tap', url: 'https://x.co/r/d/t', cutLabel: 'Whole Cow', dueNowDollars: 1536 });
  assert.match(big.html, /\$1,536 today/);
});

test('render: NO hyphens in outbound prose, either mode (Ben rule)', () => {
  const strip = (html: string) =>
    html
      .replace(/<a[^>]*>.*?<\/a>/g, ' ') // anchor text is the raw URL
      .replace(/<[^>]+>/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ');
  const quiz = renderRequalifyEmail('Jane Doe', 'CO', CV);
  const oneTap = renderRequalifyEmail('Jane Doe', 'CO', CV, {
    mode: 'one-tap',
    url: requalifyOneTapCta('CO', 'tok'),
    cutLabel: 'Half Cow',
    dueNowDollars: 832,
  });
  for (const [label, html] of [['quiz', quiz.html], ['one-tap', oneTap.html]] as const) {
    assert.ok(!strip(html).includes('-'), `${label} body must contain no hyphens`);
    assert.ok(!label.includes(' '));
  }
});

test('quiz fallback render is byte-identical whether the CTA is passed or defaulted', () => {
  const implicit = renderRequalifyEmail('Jane Doe', 'CO', CV);
  const explicit = renderRequalifyEmail('Jane Doe', 'CO', CV, { mode: 'quiz', url: requalifyCta('CO', CV.slug) });
  assert.equal(explicit.html, implicit.html);
  assert.equal(explicit.subject, implicit.subject);
});

test('links: both modes carry the same utm triple', () => {
  assert.equal(requalifyUtm('co'), 'utm_source=email&utm_medium=drip&utm_campaign=waiting-wake-co');
  assert.match(requalifyOneTapCta('NE', 'abc.def.ghi'), /^https:\/\/www\.buyhalfcow\.com\/r\/d\/abc\.def\.ghi\?utm_source=email&utm_medium=drip&utm_campaign=waiting-wake-ne$/);
  assert.match(requalifyCta('NE', CV.slug), /utm_campaign=waiting-wake-ne$/);
});
