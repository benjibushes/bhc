import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reserveAddToCartEvent,
  reserveInitiateCheckoutEvent,
  referralIdFromCheckoutPath,
} from './reserveTracking';
import { metaEventId } from './analytics';

// ─── AD-TRACKING TRUTH (2026-08-18) ────────────────────────────────────────
// These pin the two decisions the public reserve forms had wrong:
//
//   1. VALUE = what the buyer's card is actually charged (dueNow: the all-in
//      deposit with the platform fee baked in), NOT the rancher's listed price.
//      A listed-price AddToCart overstates every ad conversion by the
//      commission rate and disagrees with the server-side InitiateCheckout,
//      which reports totalChargedCents / 100.
//
//   2. The client InitiateCheckout carries the SAME event_id the server CAPI
//      fire uses — the RAW referral record id (lib/analytics metaEventId, no
//      prefix) — so Meta dedups one buyer journey into ONE InitiateCheckout
//      instead of counting two.

const BASE = {
  ranchName: 'Gila River Cattle',
  ranchSlug: 'gila-river-cattle',
  cutLabel: 'Half',
  dueNowDollars: 700,
};

// ── value semantics ────────────────────────────────────────────────────────

test('AddToCart reports the all-in dueNow charge, not the listed share price', () => {
  const e = reserveAddToCartEvent({ ...BASE, dueNowDollars: 700 });
  assert.equal(e.name, 'AddToCart');
  assert.equal(e.params.value, 700);
  assert.equal(e.params.currency, 'USD');
  assert.equal(e.params.content_name, 'Gila River Cattle');
  assert.equal(e.params.content_category, 'Half');
  assert.equal(e.params.ranchSlug, 'gila-river-cattle');
});

test('InitiateCheckout reports the same all-in dueNow value as AddToCart', () => {
  const atc = reserveAddToCartEvent({ ...BASE, dueNowDollars: 812.5 });
  const ic = reserveInitiateCheckoutEvent({ ...BASE, dueNowDollars: 812.5, referralId: 'recREF001' });
  assert.equal(ic.name, 'InitiateCheckout');
  assert.equal(ic.params.value, atc.params.value);
  assert.equal(ic.params.value, 812.5);
});

test('a missing / junk / negative value reports 0, never NaN and never a price', () => {
  for (const bad of [undefined, NaN, -50, 0, Infinity, 'lots' as unknown as number]) {
    const e = reserveAddToCartEvent({ ...BASE, dueNowDollars: bad as number });
    assert.equal(e.params.value, 0, `bad input ${String(bad)} must report 0`);
  }
});

test('fractional cents are rounded to money, not floated into Meta', () => {
  const e = reserveAddToCartEvent({ ...BASE, dueNowDollars: 700.005 });
  assert.equal(e.params.value, 700.01);
});

// ── dedup: event_id ────────────────────────────────────────────────────────

test('InitiateCheckout carries the RAW referral id as event_id (server dedup key)', () => {
  const ic = reserveInitiateCheckoutEvent({ ...BASE, referralId: 'recABC123DEF45678' });
  assert.equal(ic.params.event_id, 'recABC123DEF45678');
  // The repo-wide convention — no prefix, no namespace (lib/analytics).
  assert.equal(ic.params.event_id, metaEventId('recABC123DEF45678'));
});

test('InitiateCheckout omits event_id entirely when no referral id is known', () => {
  for (const missing of ['', undefined, '   ']) {
    const ic = reserveInitiateCheckoutEvent({ ...BASE, referralId: missing });
    assert.ok(!('event_id' in ic.params), `event_id must be absent for ${JSON.stringify(missing)}`);
  }
});

test('AddToCart never carries an event_id — no server AddToCart exists to dedup with', () => {
  assert.ok(!('event_id' in reserveAddToCartEvent({ ...BASE }).params));
  // Even when a referral id is available, AddToCart must NOT claim one: there
  // is no server-side AddToCart to dedup against, and an event_id shared with
  // a different event_name buys nothing while inviting the next reader to
  // "helpfully" reuse it.
  const withRef = reserveAddToCartEvent({ ...BASE, referralId: 'recABC123DEF45678' });
  assert.ok(!('event_id' in withRef.params), 'AddToCart must stay event_id-free');
});

// ── broker rail: the referral id has to come out of the redirect path ──────

test('referralIdFromCheckoutPath pulls the id out of a broker redirect', () => {
  assert.equal(referralIdFromCheckoutPath('/checkout/recBRK0000000001/broker?cut=half'), 'recBRK0000000001');
});

test('referralIdFromCheckoutPath handles the Connect deposit path too', () => {
  assert.equal(referralIdFromCheckoutPath('/checkout/recCON0000000001/deposit?cut=whole'), 'recCON0000000001');
});

test('referralIdFromCheckoutPath returns "" for anything it cannot trust', () => {
  for (const bad of [
    '',
    '/access?state=AZ',
    'https://evil.example.com/checkout/recX/broker',
    '/checkout//broker',
    '/checkout/recX/somethingelse',
    undefined as unknown as string,
    null as unknown as string,
  ]) {
    assert.equal(referralIdFromCheckoutPath(bad), '', `must not trust ${JSON.stringify(bad)}`);
  }
});
