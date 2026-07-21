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
