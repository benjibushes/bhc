// lib/onboardingPaths.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSellPath,
  readStoreConfig,
  evaluateOnboarding,
  MONEY_MODEL,
  commissionCopyFor,
  TIER_FEE_PERCENT,
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

// ── camelCase shape (the wizard's GET /api/rancher/setup payload) ───────────
// evaluateOnboarding is the single source of truth across surfaces, so it must
// read BOTH raw Airtable rows AND the wizard's camelCased subset. Reading only
// raw names showed contact/agreement as unfinished forever on the wizard.

test('camelCase contact fields mark contact done (wizard payload shape)', () => {
  const st = evaluateOnboarding({
    ranchName: 'Bar T Beef',
    operatorName: 'Tom Bar',
    email: 'tom@bart.example',
    phone: '555-0100',
    'Half Price': 2000,
  } as any);
  assert.equal(st.requirements.find((r) => r.key === 'contact')?.done, true);
});

test('camelCase agreementSigned marks the agreement step done', () => {
  const st = evaluateOnboarding({
    ranchName: 'B', operatorName: 'T', email: 'a@b.co', phone: '5',
    'Half Price': 2000, stripeConnectStatus: 'active', agreementSigned: true,
  } as any);
  assert.equal(st.requirements.find((r) => r.key === 'agreement')?.done, true);
  assert.equal(st.readyToGoLive, true);
});

test('camelCase stripeConnectStatus satisfies payout', () => {
  const st = evaluateOnboarding({ stripeConnectStatus: 'active' } as any);
  assert.equal(st.requirements.find((r) => r.key === 'payout')?.done, true);
});

test('store path detected from camelCase fulfillmentIntegration key', () => {
  const cfg = JSON.stringify({ provider: 'shopify', mode: 'sync', markupPercent: 15 });
  assert.equal(detectSellPath({ fulfillmentIntegration: cfg } as any), 'store');
  const st = evaluateOnboarding({ fulfillmentIntegration: cfg } as any);
  assert.equal(st.path, 'store');
  assert.deepEqual(st.requirements.map((r) => r.key), ['contact', 'store', 'markup', 'payout', 'agreement']);
});

test('MONEY_MODEL states fee-on-top for both paths and never promises no fees', () => {
  const all = Object.values(MONEY_MODEL).join(' ').toLowerCase();
  assert.match(all, /on top/);
  assert.ok(MONEY_MODEL.sharePath.length > 0 && MONEY_MODEL.storePath.length > 0);
  // Guard against re-introducing an unverified pricing promise.
  assert.doesNotMatch(all, /no monthly|free forever|no subscription/);
});

// ── commissionCopyFor — the LOCKED money model, one source ───────────────────
//
// docs/BUSINESS-MODEL.md ⭐ GROUND TRUTH: the rancher keeps 100% of the price
// they set and BHC's percentage is ADDED to the buyer (Connect
// application_fee at deposit). The wizard's SIGNATURE screen used to say "10%
// commission on closed deals only" — the deducted framing, on the one screen
// where a rancher legally signs. These tests are the fence.

// The lookbehinds matter: "never taken out of your price" and "you never owe
// us anything" are the CORRECT model stated as a negation. Only the
// affirmative deducted framing is banned.
const BANNED = [
  /we deduct/i,
  /(?<!never )deducted from/i,
  /keep 90/i,
  /minus commission/i,
  /commission on your sales/i,
  /(?<!never )you owe/i,
  /(?<!never )owe us/i,
  /we take \d/i,
  /(?<!never )taken out of/i,
];

function assertModelSafe(line: string) {
  for (const re of BANNED) {
    assert.doesNotMatch(line, re, `banned deducted-framing phrase ${re} in: ${line}`);
  }
  assert.match(line, /100%/, `must state the rancher keeps 100%: ${line}`);
}

test('commissionCopyFor: every tier rate states buyer-pays-on-top, never a deduction', () => {
  for (const [pct, label] of [
    [10, 'free plan'],
    [7, 'Pasture tier'],
    [3, 'Ranch tier'],
  ] as [number, string][]) {
    const c = commissionCopyFor(pct, label);
    assertModelSafe(c.line);
    assert.match(c.fee, new RegExp(`${pct}%`), 'the rate must be stated');
    assert.match(c.fee, /buyer pays/i);
    assert.match(c.fee, /on top/i);
    assert.match(c.fee, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('commissionCopyFor: Operator tier (0%) says no buyer fee at all, not "0% commission"', () => {
  const c = commissionCopyFor(0, 'Operator tier');
  assertModelSafe(c.line);
  assert.match(c.fee, /no service fee/i);
  assert.match(c.fee, /Operator tier/);
  // A 0% rancher must not be told a percentage is added to their buyer.
  assert.doesNotMatch(c.fee, /0% on top/);
});

test('commissionCopyFor: no tier locked yet states the RANGE, still on-top', () => {
  const c = commissionCopyFor(null);
  assertModelSafe(c.line);
  assert.match(c.fee, /10%/);
  assert.match(c.fee, /7%/);
  assert.match(c.fee, /3%/);
  assert.match(c.fee, /0%/);
  assert.match(c.line, /never taken out of your price/i);
  // undefined / NaN behave the same — never crash, never invent a rate.
  assert.equal(commissionCopyFor(undefined).line, c.line);
  assert.equal(commissionCopyFor(NaN).line, c.line);
});

test('commissionCopyFor: line is keep + fee + detail, and keep is the shared constant', () => {
  const c = commissionCopyFor(10, 'free plan');
  assert.equal(c.keep, MONEY_MODEL.keep);
  assert.equal(c.line, `${c.keep} ${c.fee} ${c.detail}`);
});

test('TIER_FEE_PERCENT mirrors the tier ladder (free 10 / Pasture 7 / Ranch 3 / Operator 0)', () => {
  assert.equal(TIER_FEE_PERCENT.legacy_connect, 10);
  assert.equal(TIER_FEE_PERCENT.pasture, 7);
  assert.equal(TIER_FEE_PERCENT.ranch, 3);
  assert.equal(TIER_FEE_PERCENT.operator, 0);
});

test('MONEY_MODEL.emailLine is safe for plain-text rancher emails', () => {
  assertModelSafe(MONEY_MODEL.emailLine);
  assert.match(MONEY_MODEL.emailLine, /paid by the buyer/i);
});

// ── contact requirement must be SATISFIABLE from inside the wizard ───────────

test('contact requirement completes on exactly what the wizard can write', () => {
  // Ranch Name is set by every signup door at creation; Operator Name, Email
  // and Phone are all now in the wizard's PATCH allowlist AND required at
  // step 1. Before that fix Operator Name was unwritable and Phone optional,
  // so this checkbox could never be ticked and the rancher had no way to fix
  // it — a permanently unchecked box on the very first screen.
  const st = evaluateOnboarding({
    'Ranch Name': 'Bar T Beef',
    'Operator Name': 'Tom Bar',
    Email: 'tom@bart.example',
    Phone: '(406) 555-1234',
  } as any);
  assert.equal(st.requirements.find((r) => r.key === 'contact')?.done, true);
});

test('contact requirement stays incomplete when the phone backstop is missing', () => {
  const st = evaluateOnboarding({
    'Ranch Name': 'Bar T Beef',
    'Operator Name': 'Tom Bar',
    Email: 'tom@bart.example',
  } as any);
  assert.equal(st.requirements.find((r) => r.key === 'contact')?.done, false);
});
