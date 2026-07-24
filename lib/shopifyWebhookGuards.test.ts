// lib/shopifyWebhookGuards.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/shopifyWebhookGuards.test.ts
//
// Batch D webhook hardening (L5–L9). Pins the pure guards AND the route wiring
// (source-shape pins, same technique as lib/shopifyOrderIngest.test.ts) so a
// silent revert on the security/correctness path fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildScopedFulfillmentOrderFilter,
  shopifyWebhookRateLimitKey,
  catalogSyncReportIndicatesFailure,
  resolveFulfillmentStampPatch,
} from './shopifyWebhookGuards';

// ── L5: fulfillment lookup is scoped to the HMAC-verified rancher ────────────

test('L5: scoped filter AND-combines order id + rancher id, both escaped', () => {
  assert.equal(
    buildScopedFulfillmentOrderFilter('gid://shopify/Order/123', 'recRANCH1'),
    'AND({External Order Id} = "gid://shopify/Order/123", {Rancher Record ID} = "recRANCH1")',
  );
});

test('L5: quotes/backslashes in either input are escaped (no formula injection)', () => {
  const f = buildScopedFulfillmentOrderFilter('gid"evil', 'rec\\x');
  assert.equal(f, 'AND({External Order Id} = "gid\\"evil", {Rancher Record ID} = "rec\\\\x")');
});

test('L5: a blank rancher id still emits the scoped clause (matches nothing, never everything)', () => {
  const f = buildScopedFulfillmentOrderFilter('gid://shopify/Order/1', '');
  assert.match(f, /\{Rancher Record ID\} = ""/);
  assert.match(f, /^AND\(/);
});

// ── L6: rate-limit bucket keys by source IP, not the spoofable shop header ───

test('L6: rate-limit key is namespaced and per-IP', () => {
  assert.equal(shopifyWebhookRateLimitKey('203.0.113.7'), 'shopify-webhook:203.0.113.7');
  assert.notEqual(shopifyWebhookRateLimitKey('1.1.1.1'), shopifyWebhookRateLimitKey('2.2.2.2'));
});

test('L6: blank/whitespace IP degrades to a stable "unknown" bucket', () => {
  assert.equal(shopifyWebhookRateLimitKey(''), 'shopify-webhook:unknown');
  assert.equal(shopifyWebhookRateLimitKey('   '), 'shopify-webhook:unknown');
  assert.equal(shopifyWebhookRateLimitKey(undefined as any), 'shopify-webhook:unknown');
});

// ── L7: a failed / partial triggered resync must be detectable ───────────────

test('L7: partial-fetch and generic failure report lines are flagged', () => {
  assert.equal(
    catalogSyncReportIndicatesFailure(['catalog fetch failed on page 3 — partial: imported 20, updated 4']),
    true,
  );
  assert.equal(catalogSyncReportIndicatesFailure(['sync failed: boom']), true);
});

test('L7: clean/benign report lines are NOT flagged (no false alerts)', () => {
  assert.equal(catalogSyncReportIndicatesFailure(['imported 12, updated 3, no-SKU skipped 1']), false);
  assert.equal(catalogSyncReportIndicatesFailure(['not in sync mode']), false);
  assert.equal(catalogSyncReportIndicatesFailure(['skipped — a sync for this rancher is already in progress']), false);
  // TRUNCATED already fires its own loud signal inside syncShopifyCatalog — must
  // NOT be double-alerted from the route.
  assert.equal(
    catalogSyncReportIndicatesFailure(['TRUNCATED — hit the 40-page cap (~2000 products fetched); products beyond 2000 were NOT synced']),
    false,
  );
  assert.equal(catalogSyncReportIndicatesFailure([]), false);
  assert.equal(catalogSyncReportIndicatesFailure(undefined), false);
  assert.equal(catalogSyncReportIndicatesFailure(null), false);
});

// ── L8: fulfillments/update overwrites corrected tracking; create fills empty ─

test('L8: fulfillments/create sets tracking only when the row is empty', () => {
  assert.deepEqual(
    resolveFulfillmentStampPatch({
      topic: 'fulfillments/create',
      incomingTracking: '1Z999',
      currentTracking: '',
      currentStatus: 'New',
      nowIso: '2026-07-24T00:00:00.000Z',
    }),
    { 'Tracking Number': '1Z999', Status: 'Shipped', 'Shipped At': '2026-07-24T00:00:00.000Z' },
  );
});

test('L8: fulfillments/create does NOT clobber an existing tracking number', () => {
  const patch = resolveFulfillmentStampPatch({
    topic: 'fulfillments/create',
    incomingTracking: 'NEW-2',
    currentTracking: 'ORIGINAL-1',
    currentStatus: 'Shipped',
    nowIso: '2026-07-24T00:00:00.000Z',
  });
  assert.deepEqual(patch, {}); // nothing to do: tracking present, status not New
});

test('L8: fulfillments/update OVERWRITES a corrected tracking number', () => {
  const patch = resolveFulfillmentStampPatch({
    topic: 'fulfillments/update',
    incomingTracking: 'CORRECTED-9',
    currentTracking: 'TYPO-1',
    currentStatus: 'Shipped',
    nowIso: '2026-07-24T00:00:00.000Z',
  });
  assert.deepEqual(patch, { 'Tracking Number': 'CORRECTED-9' });
});

test('L8: fulfillments/update with an identical tracking value is a no-op (no needless write)', () => {
  assert.deepEqual(
    resolveFulfillmentStampPatch({
      topic: 'fulfillments/update',
      incomingTracking: 'SAME-1',
      currentTracking: 'SAME-1',
      currentStatus: 'Shipped',
      nowIso: '2026-07-24T00:00:00.000Z',
    }),
    {},
  );
});

test('L8: an empty incoming tracking never wipes an existing value', () => {
  assert.deepEqual(
    resolveFulfillmentStampPatch({
      topic: 'fulfillments/update',
      incomingTracking: '',
      currentTracking: 'KEEP-1',
      currentStatus: 'Shipped',
      nowIso: '2026-07-24T00:00:00.000Z',
    }),
    {},
  );
});

test('L8: New→Shipped status stamp fires independent of tracking', () => {
  assert.deepEqual(
    resolveFulfillmentStampPatch({
      topic: 'fulfillments/update',
      incomingTracking: '',
      currentTracking: '',
      currentStatus: 'New',
      nowIso: '2026-07-24T00:00:00.000Z',
    }),
    { Status: 'Shipped', 'Shipped At': '2026-07-24T00:00:00.000Z' },
  );
});

// ── Route-shape pins: the handler can't be unit-run under `tsx --test`, so pin
// its source shape so a revert of the L5/L6/L7/L8/L9 wiring surfaces here. ────
const webhookSrc = readFileSync(
  fileURLToPath(new URL('../app/api/webhooks/shopify/route.ts', import.meta.url)),
  'utf8',
);

test('route wires L5 scoped fulfillment lookup', () => {
  assert.match(webhookSrc, /buildScopedFulfillmentOrderFilter\(/, 'must use the scoped filter builder');
  // and must NOT still look orders up by External Order Id ALONE (unscoped).
  assert.doesNotMatch(
    webhookSrc,
    /RANCHER_ORDERS,\s*`\{External Order Id\} = "\$\{escapeAirtableValue\(externalOrderId\)\}"`/,
    'the unscoped fulfillment lookup must be gone',
  );
});

test('route wires L6 shop-domain + rate-limit BEFORE the unauthenticated scan', () => {
  assert.match(webhookSrc, /isValidShopDomain\(shop\)/, 'must format-reject non *.myshopify.com shops');
  assert.match(webhookSrc, /shopifyWebhookRateLimitKey\(/, 'must rate-limit the pre-HMAC scan');
  assert.match(webhookSrc, /status:\s*429/, 'must 429 fast when rate limited');
  assert.match(webhookSrc, /status:\s*400/, 'must 400 fast on an invalid shop domain');
  // The guard must sit before the rancher-resolution full-scan.
  const guardIdx = webhookSrc.indexOf('shopifyWebhookRateLimitKey');
  const scanIdx = webhookSrc.indexOf('FIND("${escapeAirtableValue(shop)}", {Fulfillment Integration})', guardIdx);
  assert.ok(guardIdx > -1 && scanIdx > guardIdx, 'rate limit must precede the unauthenticated scan');
});

test('route keeps the compliance HMAC path intact (L6 must not weaken it)', () => {
  assert.match(webhookSrc, /COMPLIANCE_TOPICS/, 'compliance topics still handled');
  assert.match(webhookSrc, /publicAppCreds\(\)/, 'compliance still verifies with the app client secret');
});

test('route wires L7 sync-failure alert (report + throw), normal urgency', () => {
  assert.match(webhookSrc, /catalogSyncReportIndicatesFailure\(/, 'must classify the returned report');
  assert.match(webhookSrc, /shopify-catalog-sync-fail-/, 'must fire a deduped operator signal for the failure');
});

test('route wires L8 fulfillment stamp patch resolver', () => {
  assert.match(webhookSrc, /resolveFulfillmentStampPatch\(/, 'stamp must go through the resolver (create fills / update overwrites)');
});

test('route wires L9 tracking-stamp failure beacon (not fire-and-forget)', () => {
  assert.match(webhookSrc, /shopify-tracking-stamp-fail-/, 'a failed stamp must ring a deduped operator beacon');
  // the swallow-all catch on the stamp write must be gone.
  assert.doesNotMatch(
    webhookSrc,
    /updateRecord\(TABLES\.RANCHER_ORDERS, order\.id, updates\)\.catch\(\(\) => \{\}\)/,
    'the fire-and-forget .catch(()=>{}) on the stamp write must be gone',
  );
});
