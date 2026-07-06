// lib/productRecovery.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/productRecovery.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isContactable,
  isCrossSellEligible,
  isRepeatEligible,
  nextProductNudge,
  renderCrossSellEmail,
  renderRepeatEmail,
  type ProductBuyerLike,
} from './productRecovery';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

const buyer = (over: Partial<ProductBuyerLike> = {}): ProductBuyerLike => ({
  id: 'recABC',
  Email: 'dana@example.com',
  'Full Name': 'Dana Smith',
  Status: 'Active',
  'Buyer Stage': 'PRODUCT_BUYER',
  'Last Product Bought': 'Original Beef Jerky',
  'Last Product Bought At': daysAgo(12),
  'Product Buyer Rancher': 'Silverline Cattle Co',
  ...over,
});

test('isContactable: needs a real email + not suppressed', () => {
  assert.equal(isContactable(buyer()), true);
  assert.equal(isContactable(buyer({ Email: '' })), false);
  assert.equal(isContactable(buyer({ Email: 'notanemail' })), false);
  assert.equal(isContactable(buyer({ Status: 'Unsubscribed' })), false);
  assert.equal(isContactable(buyer({ Status: 'Bounced' })), false);
});

test('cross-sell: PRODUCT_BUYER past the min window, never pitched → eligible', () => {
  assert.equal(isCrossSellEligible(buyer(), { now: NOW }), true); // 12d ≥ 10d
});

test('cross-sell: too fresh (< min) → not yet', () => {
  assert.equal(isCrossSellEligible(buyer({ 'Last Product Bought At': daysAgo(3) }), { now: NOW }), false);
});

test('cross-sell: past the late cap → skip (no ancient blasts)', () => {
  assert.equal(isCrossSellEligible(buyer({ 'Last Product Bought At': daysAgo(200) }), { now: NOW }), false);
});

test('cross-sell: already sent → never again (one ever)', () => {
  assert.equal(isCrossSellEligible(buyer({ 'Share Cross-Sell Sent At': daysAgo(1) }), { now: NOW }), false);
});

test('cross-sell: not a PRODUCT_BUYER (share-funnel buyer) → excluded', () => {
  assert.equal(isCrossSellEligible(buyer({ 'Buyer Stage': 'MATCHED' }), { now: NOW }), false);
});

test('repeat: past the reorder window, never nudged → eligible', () => {
  assert.equal(isRepeatEligible(buyer({ 'Last Product Bought At': daysAgo(40) }), { now: NOW }), true); // 40 ≥ 35
});

test('repeat: before the reorder window → not yet', () => {
  assert.equal(isRepeatEligible(buyer({ 'Last Product Bought At': daysAgo(20) }), { now: NOW }), false);
});

test('repeat: already nudged → never again', () => {
  assert.equal(
    isRepeatEligible(buyer({ 'Last Product Bought At': daysAgo(40), 'Product Repeat Nudged At': daysAgo(1) }), { now: NOW }),
    false,
  );
});

test('nextProductNudge: cross-sell takes precedence when both windows overlap', () => {
  // 40d old, never cross-sold, never repeat-nudged → both eligible → cross-sell wins
  const b = buyer({ 'Last Product Bought At': daysAgo(40) });
  assert.equal(nextProductNudge(b, { now: NOW }), 'crosssell');
  // cross-sell already sent → repeat is next
  assert.equal(nextProductNudge({ ...b, 'Share Cross-Sell Sent At': daysAgo(30) }, { now: NOW }), 'repeat');
  // both done → nothing
  assert.equal(
    nextProductNudge({ ...b, 'Share Cross-Sell Sent At': daysAgo(30), 'Product Repeat Nudged At': daysAgo(1) }, { now: NOW }),
    null,
  );
});

test('renderers: carry the product + rancher, escape HTML, sign — Ben', () => {
  const cross = renderCrossSellEmail({ firstName: 'Dana', product: 'Jerky <b>', rancher: 'Silverline', url: 'https://x/map' });
  assert.match(cross.subject, /you tasted it/i);
  assert.match(cross.html, /Jerky &lt;b&gt;/); // escaped
  assert.match(cross.html, /Silverline/);
  assert.match(cross.html, /— Ben/);
  assert.match(cross.html, /https:\/\/x\/map/);

  const rep = renderRepeatEmail({ firstName: 'Dana', product: 'Jerky', rancher: 'Silverline', url: 'https://x/shop' });
  assert.match(rep.subject, /running low/i);
  assert.match(rep.html, /reorder/i);
  assert.match(rep.html, /https:\/\/x\/shop/);
});
