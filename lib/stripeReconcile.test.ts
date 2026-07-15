// lib/stripeReconcile.test.ts — decision-table pins for the stripe-reconcile
// cron's pure logic. The safety doctrine under test: ambiguity is REPORTED
// never written, Legacy Connect's synthetic status is never touched, tiers
// are never downgraded by the cron, and only EMPTY sub ids are backfilled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectValue,
  tierPriceMapFromEnv,
  isTierSubscription,
  tierSlugForSub,
  pickCurrentSubscription,
  mapStripeSubStatus,
  matchSubToRancher,
  computeSubscriptionReconcile,
  findPhantomSubscribers,
  type RancherLite,
  type SubLite,
} from './stripeReconcile';

function rancher(overrides: Partial<RancherLite> = {}): RancherLite {
  return {
    id: 'recRancher1',
    name: 'Test Ranch',
    email: 'ben@testranch.com',
    teamEmails: '',
    connectAccountId: 'acct_1',
    subscriptionId: '',
    subscriptionStatus: '',
    tier: '',
    ...overrides,
  };
}

function sub(overrides: Partial<SubLite> = {}): SubLite {
  return {
    id: 'sub_A',
    status: 'active',
    created: 1000,
    customerAccount: 'acct_1',
    customerEmail: '',
    metadataRancherId: '',
    metadataTier: '',
    priceId: 'price_pasture',
    ...overrides,
  };
}

const PRICE_MAP = { price_pasture: 'pasture', price_ranch: 'ranch', price_operator: 'operator' } as const;

// ── selectValue ─────────────────────────────────────────────────────────────

test('selectValue handles plain strings, select objects, and empties', () => {
  assert.equal(selectValue('Pasture'), 'Pasture');
  assert.equal(selectValue({ id: 'x', name: 'Ranch', color: 'green' }), 'Ranch');
  assert.equal(selectValue(null), '');
  assert.equal(selectValue(undefined), '');
});

// ── tierPriceMapFromEnv ─────────────────────────────────────────────────────

test('tierPriceMapFromEnv maps only the envs that are set', () => {
  const map = tierPriceMapFromEnv({
    STRIPE_PASTURE_PRICE_ID: 'price_p',
    STRIPE_RANCH_PRICE_ID: '  price_r  ',
    STRIPE_OPERATOR_PRICE_ID: '',
  });
  assert.deepEqual(map, { price_p: 'pasture', price_r: 'ranch' });
});

test('tierPriceMapFromEnv on empty env yields empty map (no throw)', () => {
  assert.deepEqual(tierPriceMapFromEnv({}), {});
});

// ── isTierSubscription / tierSlugForSub ─────────────────────────────────────

test('tier sub detection: price match OR rancherId metadata; metadata.tier alone is NOT enough', () => {
  assert.equal(isTierSubscription(sub({ priceId: 'price_ranch' }), PRICE_MAP), true);
  assert.equal(isTierSubscription(sub({ priceId: 'price_other', metadataRancherId: 'recX' }), PRICE_MAP), true);
  // A brand/founder sub with a coincidental 'tier' metadata key must not leak in.
  assert.equal(
    isTierSubscription(sub({ priceId: 'price_brand', metadataTier: 'pasture' }), PRICE_MAP),
    false,
  );
});

test('tierSlugForSub: price wins over metadata; metadata is the fallback; junk → null', () => {
  assert.equal(tierSlugForSub(sub({ priceId: 'price_operator', metadataTier: 'pasture' }), PRICE_MAP), 'operator');
  assert.equal(tierSlugForSub(sub({ priceId: 'price_unknown', metadataTier: 'Ranch' }), PRICE_MAP), 'ranch');
  assert.equal(tierSlugForSub(sub({ priceId: 'price_unknown', metadataTier: 'gold' }), PRICE_MAP), null);
});

// ── pickCurrentSubscription ─────────────────────────────────────────────────

test('pickCurrentSubscription prefers the livest status', () => {
  const picked = pickCurrentSubscription([
    sub({ id: 'sub_old', status: 'canceled', created: 2000 }),
    sub({ id: 'sub_live', status: 'active', created: 1000 }),
    sub({ id: 'sub_due', status: 'past_due', created: 3000 }),
  ]);
  assert.equal(picked?.id, 'sub_live');
});

test('pickCurrentSubscription breaks status ties by recency', () => {
  const picked = pickCurrentSubscription([
    sub({ id: 'sub_older', status: 'canceled', created: 1000 }),
    sub({ id: 'sub_newer', status: 'canceled', created: 2000 }),
  ]);
  assert.equal(picked?.id, 'sub_newer');
});

test('pickCurrentSubscription: empty → null; unknown statuses rank last', () => {
  assert.equal(pickCurrentSubscription([]), null);
  const picked = pickCurrentSubscription([
    sub({ id: 'sub_weird', status: 'some_future_status', created: 9000 }),
    sub({ id: 'sub_canceled', status: 'canceled', created: 1 }),
  ]);
  assert.equal(picked?.id, 'sub_canceled');
});

// ── mapStripeSubStatus ──────────────────────────────────────────────────────

test('mapStripeSubStatus is identity except incomplete_expired → canceled', () => {
  for (const s of ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete', 'canceled']) {
    assert.equal(mapStripeSubStatus(s), s);
  }
  assert.equal(mapStripeSubStatus('incomplete_expired'), 'canceled');
  assert.equal(mapStripeSubStatus('  Active '), 'active');
});

// ── matchSubToRancher ───────────────────────────────────────────────────────

test('match order 1: metadata.rancherId wins even when acct/email also present', () => {
  const target = rancher({ id: 'recTarget', connectAccountId: 'acct_other' });
  const decoy = rancher({ id: 'recDecoy', connectAccountId: 'acct_1' });
  const m = matchSubToRancher(sub({ metadataRancherId: 'recTarget' }), [decoy, target]);
  assert.equal(m.kind, 'matched');
  if (m.kind === 'matched') {
    assert.equal(m.rancher.id, 'recTarget');
    assert.equal(m.via, 'metadata');
  }
});

test('metadata.rancherId pointing at a missing row → unmatched (reported, never guessed)', () => {
  const m = matchSubToRancher(sub({ metadataRancherId: 'recGone' }), [rancher()]);
  assert.equal(m.kind, 'unmatched');
});

test('match order 2: unique customer_account → Stripe Connect Account Id', () => {
  const m = matchSubToRancher(sub({ customerAccount: 'acct_1' }), [
    rancher({ id: 'recA', connectAccountId: 'acct_1' }),
    rancher({ id: 'recB', connectAccountId: 'acct_2' }),
  ]);
  assert.equal(m.kind, 'matched');
  if (m.kind === 'matched') assert.equal(m.via, 'connect-account');
});

test('two ranchers sharing a Connect acct → ambiguous, never a write', () => {
  const m = matchSubToRancher(sub({ customerAccount: 'acct_dup' }), [
    rancher({ id: 'recA', connectAccountId: 'acct_dup' }),
    rancher({ id: 'recB', connectAccountId: 'acct_dup' }),
  ]);
  assert.equal(m.kind, 'ambiguous');
  if (m.kind === 'ambiguous') assert.deepEqual(m.candidateIds, ['recA', 'recB']);
});

test('match order 3: unique case-insensitive email fallback', () => {
  const m = matchSubToRancher(
    sub({ customerAccount: 'acct_unknown', customerEmail: 'BEN@TestRanch.com' }),
    [rancher({ email: 'ben@testranch.com' }), rancher({ id: 'rec2', email: 'other@x.com' })],
  );
  assert.equal(m.kind, 'matched');
  if (m.kind === 'matched') assert.equal(m.via, 'email');
});

test('email fallback also searches Team Emails (split on space/comma/semicolon/newline)', () => {
  const m = matchSubToRancher(sub({ customerAccount: '', customerEmail: 'hand@ranch.com' }), [
    rancher({ email: 'owner@ranch.com', teamEmails: 'spouse@ranch.com; hand@ranch.com\nvet@ranch.com' }),
  ]);
  assert.equal(m.kind, 'matched');
});

test('email matching 0 or >1 ranchers → unmatched / ambiguous', () => {
  const none = matchSubToRancher(sub({ customerAccount: '', customerEmail: 'ghost@x.com' }), [rancher()]);
  assert.equal(none.kind, 'unmatched');
  const dup = matchSubToRancher(sub({ customerAccount: '', customerEmail: 'ben@testranch.com' }), [
    rancher({ id: 'recA' }),
    rancher({ id: 'recB', teamEmails: 'ben@testranch.com' }),
  ]);
  assert.equal(dup.kind, 'ambiguous');
});

test('no identifying keys at all → unmatched', () => {
  const m = matchSubToRancher(sub({ customerAccount: '', customerEmail: '' }), [rancher()]);
  assert.equal(m.kind, 'unmatched');
});

// ── computeSubscriptionReconcile ────────────────────────────────────────────

test('Champion Valley class: empty sub id backfilled + status synced + tier from price', () => {
  const d = computeSubscriptionReconcile(
    rancher({ subscriptionId: '', subscriptionStatus: '', tier: '' }),
    sub({ id: 'sub_live', status: 'active', priceId: 'price_pasture' }),
    'pasture',
  );
  assert.deepEqual(d.writeFields, {
    'Stripe Subscription Id': 'sub_live',
    'Subscription Status': 'active',
    'Tier': 'Pasture',
  });
  assert.equal(d.cancellationHealed, false);
  assert.equal(d.reports.length, 0);
});

test('fully in-sync row produces zero writes and zero reports', () => {
  const d = computeSubscriptionReconcile(
    rancher({ subscriptionId: 'sub_live', subscriptionStatus: 'active', tier: 'Pasture' }),
    sub({ id: 'sub_live', status: 'active' }),
    'pasture',
  );
  assert.deepEqual(d.writeFields, {});
  assert.equal(d.changes.length, 0);
  assert.equal(d.reports.length, 0);
});

test('non-empty differing sub id is REPORTED, never overwritten', () => {
  const d = computeSubscriptionReconcile(
    rancher({ subscriptionId: 'sub_stale', subscriptionStatus: 'active', tier: 'Pasture' }),
    sub({ id: 'sub_new', status: 'active' }),
    'pasture',
  );
  assert.equal(d.writeFields['Stripe Subscription Id'], undefined);
  assert.equal(d.reports.length, 1);
  assert.match(d.reports[0], /NOT overwritten/);
});

test('missed cancellation heals status and raises the loud flag', () => {
  const d = computeSubscriptionReconcile(
    rancher({ subscriptionId: 'sub_A', subscriptionStatus: 'active', tier: 'Ranch' }),
    sub({ id: 'sub_A', status: 'canceled', priceId: 'price_ranch' }),
    'ranch',
  );
  assert.equal(d.writeFields['Subscription Status'], 'canceled');
  assert.equal(d.cancellationHealed, true);
  // Tier consequence of a cancellation is webhook/Ben territory — no Tier write.
  assert.equal(d.writeFields['Tier'], undefined);
});

test('tier disagreement is written only from a LIVE sub', () => {
  const live = computeSubscriptionReconcile(
    rancher({ subscriptionId: 'sub_A', subscriptionStatus: 'active', tier: 'Pasture' }),
    sub({ id: 'sub_A', status: 'active', priceId: 'price_ranch' }),
    'ranch',
  );
  assert.equal(live.writeFields['Tier'], 'Ranch');

  const dead = computeSubscriptionReconcile(
    rancher({ subscriptionId: 'sub_A', subscriptionStatus: 'canceled', tier: 'Pasture' }),
    sub({ id: 'sub_A', status: 'canceled', priceId: 'price_ranch' }),
    'ranch',
  );
  assert.equal(dead.writeFields['Tier'], undefined);
  assert.equal(dead.reports.length, 1);
});

test('trialing counts as live for the tier write', () => {
  const d = computeSubscriptionReconcile(
    rancher({ subscriptionId: 'sub_A', subscriptionStatus: 'trialing', tier: '' }),
    sub({ id: 'sub_A', status: 'trialing', priceId: 'price_operator' }),
    'operator',
  );
  assert.equal(d.writeFields['Tier'], 'Operator');
});

test('Legacy Connect rancher with a real Stripe sub → report-only, zero writes', () => {
  const d = computeSubscriptionReconcile(
    rancher({ tier: 'Legacy Connect', subscriptionStatus: 'active', subscriptionId: '' }),
    sub({ id: 'sub_A', status: 'active' }),
    'pasture',
  );
  assert.deepEqual(d.writeFields, {});
  assert.equal(d.reports.length, 1);
  assert.match(d.reports[0], /Legacy Connect/);
});

test('Airtable select-object Tier values are handled (singleSelect landmine)', () => {
  // The route flattens via selectValue; a pre-flattened 'Pasture' from an
  // object shape must compare equal and produce no Tier write.
  const d = computeSubscriptionReconcile(
    rancher({ subscriptionId: 'sub_A', subscriptionStatus: 'active', tier: selectValue({ name: 'Pasture' }) }),
    sub({ id: 'sub_A', status: 'active', priceId: 'price_pasture' }),
    'pasture',
  );
  assert.equal(d.writeFields['Tier'], undefined);
});

test('incomplete_expired sub heals status as canceled (webhook-deleted equivalent)', () => {
  const d = computeSubscriptionReconcile(
    rancher({ subscriptionId: 'sub_A', subscriptionStatus: 'active', tier: 'Pasture' }),
    sub({ id: 'sub_A', status: 'incomplete_expired' }),
    'pasture',
  );
  assert.equal(d.writeFields['Subscription Status'], 'canceled');
  assert.equal(d.cancellationHealed, true);
});

// ── findPhantomSubscribers ──────────────────────────────────────────────────

test('phantom = active/trialing + paid tier + no Stripe sub matched', () => {
  const phantom = rancher({ id: 'recPhantom', subscriptionStatus: 'active', tier: 'Ranch' });
  const matched = rancher({ id: 'recMatched', subscriptionStatus: 'active', tier: 'Pasture' });
  const legacy = rancher({ id: 'recLegacy', subscriptionStatus: 'active', tier: 'Legacy Connect' });
  const canceled = rancher({ id: 'recCanceled', subscriptionStatus: 'canceled', tier: 'Operator' });
  const noTier = rancher({ id: 'recNoTier', subscriptionStatus: 'active', tier: 'None' });
  const trialing = rancher({ id: 'recTrial', subscriptionStatus: 'trialing', tier: 'Operator' });

  const out = findPhantomSubscribers(
    [phantom, matched, legacy, canceled, noTier, trialing],
    new Set(['recMatched']),
  );
  assert.deepEqual(out.map((r) => r.id).sort(), ['recPhantom', 'recTrial']);
});

test('phantom check handles select-object status/tier shapes via selectValue flattening', () => {
  const r = rancher({
    id: 'recObj',
    subscriptionStatus: selectValue({ name: 'active' }),
    tier: selectValue({ name: 'Pasture' }),
  });
  assert.equal(findPhantomSubscribers([r], new Set()).length, 1);
});
