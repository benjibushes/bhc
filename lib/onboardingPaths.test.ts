// lib/onboardingPaths.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSellPath,
  readStoreConfig,
  evaluateOnboarding,
  MONEY_MODEL,
} from './onboardingPaths';

// A rancher who has done nothing yet.
const blank = () => ({ 'Ranch Name': 'Bar T Beef' }) as any;

// A rancher who has everything for the SHARES path.
const sharesDone = () => ({
  'Ranch Name': 'Bar T Beef',
  'Operator Name': 'Tom Bar',
  Email: 'tom@bart.example',
  Phone: '555-0100',
  'Half Price': 2000,
  'Pricing Model': 'tier_v2',
  'Stripe Connect Status': 'active',
  'Agreement Signed': true,
}) as any;

const storeIntegration = (over: any = {}) =>
  JSON.stringify({ provider: 'shopify', mode: 'sync', markupPercent: 15, ...over });

// ── readStoreConfig ─────────────────────────────────────────────────────────

test('readStoreConfig: parses a stored Fulfillment Integration blob', () => {
  const cfg = readStoreConfig(storeIntegration());
  assert.equal(cfg?.provider, 'shopify');
  assert.equal(cfg?.markupPercent, 15);
});

test('readStoreConfig: null for blank / malformed JSON (never throws)', () => {
  assert.equal(readStoreConfig(''), null);
  assert.equal(readStoreConfig(null), null);
  assert.equal(readStoreConfig('{not json'), null);
  assert.equal(readStoreConfig('[]'), null);
});

test('readStoreConfig: a blob with no provider is not a connected store', () => {
  assert.equal(readStoreConfig(JSON.stringify({ mode: 'sync' })), null);
});

// ── detectSellPath ──────────────────────────────────────────────────────────

test('detectSellPath: defaults to shares when no store is connected', () => {
  assert.equal(detectSellPath(blank()), 'shares');
});

test('detectSellPath: store once a fulfillment integration is connected', () => {
  assert.equal(
    detectSellPath({ ...blank(), 'Fulfillment Integration': storeIntegration() }),
    'store',
  );
});

// ── evaluateOnboarding — SHARES path ────────────────────────────────────────

test('shares path: a blank rancher needs contact, prices, payout, agreement', () => {
  const st = evaluateOnboarding(blank());
  assert.equal(st.path, 'shares');
  assert.equal(st.readyToGoLive, false);
  assert.deepEqual(
    st.requirements.map((r) => r.key),
    ['contact', 'prices', 'payout', 'agreement'],
  );
  assert.equal(st.requirements.every((r) => !r.done), true);
});

test('shares path: fully set up rancher is ready to go live', () => {
  const st = evaluateOnboarding(sharesDone());
  assert.equal(st.readyToGoLive, true);
  assert.equal(st.nextAction, null);
});

test('shares path: any one priced tier satisfies prices', () => {
  for (const field of ['Quarter Price', 'Half Price', 'Whole Price']) {
    const r: any = { ...sharesDone(), 'Quarter Price': 0, 'Half Price': 0, 'Whole Price': 0 };
    r[field] = 1500;
    const st = evaluateOnboarding(r);
    assert.equal(st.requirements.find((x) => x.key === 'prices')?.done, true, field);
  }
});

test('shares path: zero/blank prices do not count', () => {
  const st = evaluateOnboarding({ ...sharesDone(), 'Half Price': 0 });
  assert.equal(st.requirements.find((r) => r.key === 'prices')?.done, false);
  assert.equal(st.readyToGoLive, false);
});

// ── the ONE road: Connect is required on BOTH paths ─────────────────────────

test('payout requirement exists on BOTH paths — Connect is the one road', () => {
  const shares = evaluateOnboarding(blank());
  const store = evaluateOnboarding({ ...blank(), 'Fulfillment Integration': storeIntegration() });
  for (const st of [shares, store]) {
    const payout = st.requirements.find((r) => r.key === 'payout');
    assert.ok(payout, `${st.path} must have a payout requirement`);
    assert.equal(payout!.actor, 'rancher'); // irreducible
  }
});

test('payout is done only when Stripe Connect is active', () => {
  const notYet = evaluateOnboarding({ ...sharesDone(), 'Stripe Connect Status': 'onboarding' });
  assert.equal(notYet.requirements.find((r) => r.key === 'payout')?.done, false);
  assert.equal(notYet.readyToGoLive, false);
});

// ── evaluateOnboarding — STORE path ─────────────────────────────────────────

test('store path: swaps the prices step for store + markup', () => {
  const st = evaluateOnboarding({ ...blank(), 'Fulfillment Integration': storeIntegration() });
  assert.equal(st.path, 'store');
  const keys = st.requirements.map((r) => r.key);
  assert.deepEqual(keys, ['contact', 'store', 'markup', 'payout', 'agreement']);
  assert.equal(keys.includes('prices'), false);
});

test('store path: connected store marks the store step done', () => {
  const st = evaluateOnboarding({ ...blank(), 'Fulfillment Integration': storeIntegration() });
  assert.equal(st.requirements.find((r) => r.key === 'store')?.done, true);
});

test('store path: a connected store with NO markup is not ready — that is the leak', () => {
  const st = evaluateOnboarding({
    ...sharesDone(),
    'Fulfillment Integration': storeIntegration({ markupPercent: null }),
  });
  assert.equal(st.requirements.find((r) => r.key === 'markup')?.done, false);
  assert.equal(st.readyToGoLive, false, 'must not go live with a 0% take rate');
});

test('store path: zero markup is treated as unset (BHC would earn nothing)', () => {
  const st = evaluateOnboarding({
    ...sharesDone(),
    'Fulfillment Integration': storeIntegration({ markupPercent: 0 }),
  });
  assert.equal(st.requirements.find((r) => r.key === 'markup')?.done, false);
});

// ── ordering: admin-fillable first, irreducible last ────────────────────────

test('irreducible rancher steps come LAST so admin can pre-fill everything else', () => {
  const st = evaluateOnboarding(blank());
  const actors = st.requirements.map((r) => r.actor);
  const firstRancher = actors.indexOf('rancher');
  // every 'either' step precedes every 'rancher' step
  assert.equal(actors.slice(firstRancher).every((a) => a === 'rancher'), true);
});

test('nextAction is the first incomplete requirement', () => {
  const st = evaluateOnboarding({ ...blank(), 'Operator Name': 'Tom Bar', Email: 't@x.co', Phone: '555' });
  assert.equal(st.nextAction?.key, 'prices');
});

// ── live state ──────────────────────────────────────────────────────────────

test('isLive only when Active Status=Active and Onboarding Status=Live', () => {
  assert.equal(evaluateOnboarding(sharesDone()).isLive, false);
  const live = evaluateOnboarding({
    ...sharesDone(),
    'Active Status': 'Active',
    'Onboarding Status': 'Live',
  });
  assert.equal(live.isLive, true);
});

// ── money model copy ────────────────────────────────────────────────────────

test('MONEY_MODEL states fee-on-top for both paths and never promises no fees', () => {
  const all = Object.values(MONEY_MODEL).join(' ').toLowerCase();
  assert.match(all, /on top/);
  assert.ok(MONEY_MODEL.sharePath.length > 0 && MONEY_MODEL.storePath.length > 0);
  // Guard against re-introducing an unverified pricing promise.
  assert.doesNotMatch(all, /no monthly|free forever|no subscription/);
});
