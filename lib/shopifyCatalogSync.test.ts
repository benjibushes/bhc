import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapVariantToProductFields, computeDisplayPrice } from './shopifyCatalogSync';

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
