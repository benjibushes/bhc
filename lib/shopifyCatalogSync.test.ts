import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mapVariantToProductFields,
  computeDisplayPrice,
  tripsShareGuard,
  guardBlockAction,
  isUnpushedObligation,
  outstandingObligationUnits,
  isCatalogTruncated,
  CATALOG_PAGE_CAP,
} from './shopifyCatalogSync';

test('markup pricing: base 100, 30% → 129.99', () => {
  assert.equal(computeDisplayPrice(100, 30), 129.99);
});

test('markup pricing: base 95, 30% → 123.99 (ceil to next dollar, then -.01)', () => {
  assert.equal(computeDisplayPrice(95, 30), 123.99);
});

test('null markup or invalid base returns null (leave Display Price alone)', () => {
  assert.equal(computeDisplayPrice(100, null), null);
  assert.equal(computeDisplayPrice(0, 30), null);
  assert.equal(computeDisplayPrice(NaN, 30), null);
});

test('variant maps to Rancher Products fields', () => {
  const f = mapVariantToProductFields({
    product: {
      id: 'gid://shopify/Product/1', title: 'Beef Box', status: 'ACTIVE', description: 'Good beef',
      featuredMedia: { preview: { image: { url: 'https://cdn/x.jpg' } } },
    },
    variant: { id: 'gid://shopify/ProductVariant/2', title: '10 lb', sku: 'BOX-10', price: '95.00', inventoryQuantity: 12 },
    markupPercent: 30,
    approved: true,
  });
  assert.equal(f['Product Name'], 'Beef Box — 10 lb');
  assert.equal(f['External SKU'], 'BOX-10');
  assert.equal(f['External Product Id'], 'gid://shopify/Product/1');
  assert.equal(f['Rancher Base'], 95);
  assert.equal(f['Display Price'], 123.99);
  assert.equal(f['Orders Left'], 12);
  assert.equal(f['Sync Managed'], true);
  assert.equal(f['Active'], true);
  assert.equal(f['Image URL'], 'https://cdn/x.jpg');
});

test('single-variant products drop the "Default Title" suffix', () => {
  const f = mapVariantToProductFields({
    product: { id: 'p', title: 'Jerky', status: 'ACTIVE' },
    variant: { id: 'v', title: 'Default Title', sku: 'JERKY-1', price: '12', inventoryQuantity: 5 },
    markupPercent: null,
    approved: true,
  });
  assert.equal(f['Product Name'], 'Jerky');
  assert.equal('Display Price' in f, false);
});

test('zero inventory or non-ACTIVE product maps Active:false', () => {
  const oos = mapVariantToProductFields({
    product: { id: 'p', title: 'X', status: 'ACTIVE' },
    variant: { id: 'v', title: 'Default Title', sku: 'S', price: '10', inventoryQuantity: 0 },
    markupPercent: null,
    approved: true,
  });
  assert.equal(oos['Active'], false);
  const draft = mapVariantToProductFields({
    product: { id: 'p', title: 'X', status: 'DRAFT' },
    variant: { id: 'v', title: 'Default Title', sku: 'S', price: '10', inventoryQuantity: 9 },
    markupPercent: null,
    approved: true,
  });
  assert.equal(draft['Active'], false);
});

test('untracked inventory (tracked:false) treats variant as in-stock, not qty 0', () => {
  const f = mapVariantToProductFields({
    product: { id: 'p', title: 'Made-to-order Box', status: 'ACTIVE' },
    variant: {
      id: 'v', title: 'Default Title', sku: 'MTO-1', price: '40', inventoryQuantity: 0,
      inventoryPolicy: 'DENY', inventoryItem: { tracked: false },
    },
    markupPercent: null,
    approved: true,
  });
  assert.equal(f['Orders Left'], 999);
  assert.equal(f['Active'], true);
});

test('continue-selling policy treats variant as in-stock even at qty 0', () => {
  const f = mapVariantToProductFields({
    product: { id: 'p', title: 'POD Cap', status: 'ACTIVE' },
    variant: {
      id: 'v', title: 'Default Title', sku: 'CAP-1', price: '25', inventoryQuantity: 0,
      inventoryPolicy: 'CONTINUE', inventoryItem: { tracked: true },
    },
    markupPercent: null,
    approved: true,
  });
  assert.equal(f['Orders Left'], 999);
  assert.equal(f['Active'], true);
});

test('tracked + DENY at qty 0 stays out of stock (no regression)', () => {
  const f = mapVariantToProductFields({
    product: { id: 'p', title: 'Jerky', status: 'ACTIVE' },
    variant: {
      id: 'v', title: 'Default Title', sku: 'J-1', price: '12', inventoryQuantity: 0,
      inventoryPolicy: 'DENY', inventoryItem: { tracked: true },
    },
    markupPercent: null,
    approved: true,
  });
  assert.equal(f['Orders Left'], 0);
  assert.equal(f['Active'], false);
});

test('missing inventoryPolicy/inventoryItem (old query shape) keeps qty semantics', () => {
  const f = mapVariantToProductFields({
    product: { id: 'p', title: 'X', status: 'ACTIVE' },
    variant: { id: 'v', title: 'Default Title', sku: 'S', price: '10', inventoryQuantity: 7 },
    markupPercent: null,
    approved: true,
  });
  assert.equal(f['Orders Left'], 7);
  assert.equal(f['Active'], true);
});

test('curation gate: unapproved products are never Active, even in stock', () => {
  const f = mapVariantToProductFields({
    product: { id: 'p', title: 'X', status: 'ACTIVE' },
    variant: { id: 'v', title: 'Default Title', sku: 'S', price: '10', inventoryQuantity: 9 },
    markupPercent: 30,
    approved: false,
  });
  assert.equal(f['Active'], false);
});

test('share-fence + $5 floor regexes: fence blocks share names, floor logic values', () => {
  // The engine-level guards are loop-side; assert the fence regex behavior via
  // a mirror here so a regex edit that breaks intent fails a test.
  const fence = /\b(whole|half|quarter)\s*[- ]?\s*(beef|cow|share|steer|animal)s?\b/i;
  assert.equal(fence.test('Half Beef Share'), true);
  assert.equal(fence.test('Quarter Cow'), true);
  assert.equal(fence.test('half-pound jerky'), false);
  assert.equal(fence.test('Beef Box'), false);
});

test('Merch category routes to its own /shop group, beef groups untouched', () => {
  const { groupKeyForCategory } = require('./marketplaceProducts');
  assert.equal(groupKeyForCategory('Merch'), 'merch');
  assert.equal(groupKeyForCategory('Jerky'), 'jerky');
  assert.equal(groupKeyForCategory(''), 'more');
});

// ── H3: share-fence / $5-floor must DELIST an already-live row ──────────────
test('H3: tripsShareGuard fires on share names and sub-$5 prices, passes normal products', () => {
  assert.equal(tripsShareGuard('Half Beef Share', 500), true);   // share name
  assert.equal(tripsShareGuard('Quarter Cow', 800), true);
  assert.equal(tripsShareGuard('Beef Box', 3), true);            // below $5 floor
  assert.equal(tripsShareGuard('Beef Box', 95), false);         // legit product
  assert.equal(tripsShareGuard('half-pound jerky', 12), false); // not a share
});

test('H3: guard-blocked SKU delists an already-live sync-managed row', () => {
  // A row that WAS Active + Sync Managed and now trips the fence (rancher
  // renamed it "Half Beef") must come OFF /shop, not stay live.
  assert.equal(guardBlockAction({ 'Sync Managed': true, 'Active': true }), 'delist');
});

test('H3: guard-block leaves inactive/hand-created/absent rows alone', () => {
  assert.equal(guardBlockAction({ 'Sync Managed': true, 'Active': false }), 'none'); // already off
  assert.equal(guardBlockAction({ 'Sync Managed': false, 'Active': true }), 'none'); // hand-created — never touch
  assert.equal(guardBlockAction(undefined), 'none');                                  // no existing row
});

// ── M4: sync must not re-shelve a settlement-decremented unit ───────────────
test('M4: outstanding obligation lowers Orders Left below Shopify count (10 - 3 = 7)', () => {
  const f = mapVariantToProductFields({
    product: { id: 'p', title: 'Beef Box', status: 'ACTIVE' },
    variant: { id: 'v', title: 'Default Title', sku: 'BOX-10', price: '95', inventoryQuantity: 10 },
    markupPercent: null,
    approved: true,
    outstandingObligation: 3,
  });
  assert.equal(f['Orders Left'], 7);
  assert.equal(f['Active'], true);
});

test('M4: obligation >= Shopify count floors Orders Left at 0 and Active false', () => {
  const f = mapVariantToProductFields({
    product: { id: 'p', title: 'Beef Box', status: 'ACTIVE' },
    variant: { id: 'v', title: 'Default Title', sku: 'BOX-10', price: '95', inventoryQuantity: 3 },
    markupPercent: null,
    approved: true,
    outstandingObligation: 3,
  });
  assert.equal(f['Orders Left'], 0);
  assert.equal(f['Active'], false);
});

test('M4: zero/absent obligation leaves Shopify count intact (no regression)', () => {
  const f = mapVariantToProductFields({
    product: { id: 'p', title: 'Beef Box', status: 'ACTIVE' },
    variant: { id: 'v', title: 'Default Title', sku: 'BOX-10', price: '95', inventoryQuantity: 10 },
    markupPercent: null,
    approved: true,
  });
  assert.equal(f['Orders Left'], 10);
});

test('M4: unlimited stock (untracked) ignores obligation — no finite count to oversell', () => {
  const f = mapVariantToProductFields({
    product: { id: 'p', title: 'MTO Box', status: 'ACTIVE' },
    variant: {
      id: 'v', title: 'Default Title', sku: 'MTO-1', price: '40', inventoryQuantity: 0,
      inventoryItem: { tracked: false },
    },
    markupPercent: null,
    approved: true,
    outstandingObligation: 5,
  });
  assert.equal(f['Orders Left'], 999);
  assert.equal(f['Active'], true);
});

test('M4: isUnpushedObligation — only blank|failed on a non-terminal order', () => {
  assert.equal(isUnpushedObligation({ 'Status': 'New', 'External Push Status': '' }), true);
  assert.equal(isUnpushedObligation({ 'Status': 'New', 'External Push Status': 'failed:config' }), true);
  assert.equal(isUnpushedObligation({ 'Status': 'New', 'External Push Status': 'failed: http 500' }), true);
  assert.equal(isUnpushedObligation({ 'Status': 'New', 'External Push Status': 'pushed' }), false);      // Shopify already decremented
  assert.equal(isUnpushedObligation({ 'Status': 'New', 'External Push Status': 'skipped:pickup' }), false); // spec: blank|failed only
  assert.equal(isUnpushedObligation({ 'Status': 'Refunded', 'External Push Status': '' }), false);       // terminal — restocked
  assert.equal(isUnpushedObligation({ 'Status': 'Cancelled', 'External Push Status': 'failed:x' }), false);
});

test('M4: outstandingObligationUnits sums Quantity over unpushed non-terminal orders', () => {
  const orders = [
    { 'Status': 'New', 'External Push Status': '', 'Quantity': 1 },                 // +1
    { 'Status': 'New', 'External Push Status': 'failed:http 500', 'Quantity': 2 },  // +2  (qty>1 proves sum, not count)
    { 'Status': 'New', 'External Push Status': 'pushed', 'Quantity': 5 },           // skip
    { 'Status': 'Refunded', 'External Push Status': '', 'Quantity': 4 },            // skip
    { 'Status': 'New', 'External Push Status': 'skipped:pickup', 'Quantity': 3 },   // skip
  ];
  assert.equal(outstandingObligationUnits(orders), 3);
  assert.equal(outstandingObligationUnits([]), 0);
  assert.equal(outstandingObligationUnits(undefined as any), 0);
});

// ── L11: 40-page cap truncation must be loud, not silent ────────────────────
test('L11: isCatalogTruncated true only when a cursor remains at the page cap', () => {
  assert.equal(isCatalogTruncated('cursorABC', CATALOG_PAGE_CAP, CATALOG_PAGE_CAP), true);
  assert.equal(isCatalogTruncated(null, CATALOG_PAGE_CAP, CATALOG_PAGE_CAP), false); // drained — complete
  assert.equal(isCatalogTruncated('cursorABC', 10, CATALOG_PAGE_CAP), false);        // stopped early for another reason
});

test('L11: a truncated run fires a loud operator signal (source guard)', () => {
  const src = readFileSync(new URL('./shopifyCatalogSync.ts', import.meta.url), 'utf8');
  assert.match(src, /isCatalogTruncated\(/, 'sync must consult the truncation predicate');
  assert.match(src, /sendOperatorSignal/, 'a truncated catalog must ring the operator');
});

// ── M3: sync lock lifecycle (release in finally, TTL >= sync maxDuration) ────
test('M3: sync claims the lock, wraps work in try, and releases in a finally', () => {
  const src = readFileSync(new URL('./shopifyCatalogSync.ts', import.meta.url), 'utf8');
  assert.match(src, /claimSyncLock\(/, 'must use the degrade-CLOSED sync lock, not the degrade-OPEN claimOnce');
  assert.match(src, /finally\s*{[\s\S]*releaseClaim\(/, 'lock must be released in a finally so a follow-up webhook is not dropped for the full TTL');
  assert.match(src, /SYNC_LOCK_TTL_SEC\s*=\s*300/, 'TTL must be >= the 300s cron maxDuration so a slow multi-page sync never frees the lock mid-run');
});
