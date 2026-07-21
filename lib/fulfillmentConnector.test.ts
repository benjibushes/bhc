import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntegration } from './fulfillmentConnector';

const good = JSON.stringify({ v: 1, provider: 'shopify', shop: 'x.myshopify.com', encToken: 'v1:a:b:c', encApiSecret: 'v1:a:b:c', mode: 'manual', markupPercent: 30 });

test('parses valid config', () => {
  const cfg = parseIntegration(good);
  assert.equal(cfg?.provider, 'shopify');
  assert.equal(cfg?.shop, 'x.myshopify.com');
  assert.equal(cfg?.mode, 'manual');
  assert.equal(cfg?.markupPercent, 30);
});

test('normalizes shop case + trims', () => {
  const cfg = parseIntegration(JSON.stringify({ v: 1, provider: 'shopify', shop: '  X.MyShopify.com ', encToken: 'e', encApiSecret: 'e', mode: 'sync' }));
  assert.equal(cfg?.shop, 'x.myshopify.com');
  assert.equal(cfg?.markupPercent, null);
});

test('null on blank / malformed / wrong version / unknown provider / bad shop / bad mode', () => {
  assert.equal(parseIntegration(''), null);
  assert.equal(parseIntegration(undefined), null);
  assert.equal(parseIntegration('{not json'), null);
  assert.equal(parseIntegration(JSON.stringify({ v: 2, provider: 'shopify' })), null);
  assert.equal(parseIntegration(JSON.stringify({ v: 1, provider: 'ebay', shop: 'x.myshopify.com', encToken: 'x', encApiSecret: 'x', mode: 'manual' })), null);
  assert.equal(parseIntegration(JSON.stringify({ v: 1, provider: 'shopify', shop: 'https://evil.com', encToken: 'x', encApiSecret: 'x', mode: 'manual' })), null);
  assert.equal(parseIntegration(JSON.stringify({ v: 1, provider: 'shopify', shop: 'evil.com', encToken: 'x', encApiSecret: 'x', mode: 'manual' })), null);
  assert.equal(parseIntegration(JSON.stringify({ v: 1, provider: 'shopify', shop: 'x.myshopify.com', encToken: 'x', encApiSecret: 'x', mode: 'auto' })), null);
  assert.equal(parseIntegration(JSON.stringify({ v: 1, provider: 'shopify', shop: 'x.myshopify.com', mode: 'manual' })), null);
});

test('config category parses and caps length; absent → null', () => {
  const base = { v: 1, provider: 'shopify', shop: 'x.myshopify.com', encToken: 'e', encApiSecret: 'e', mode: 'sync' };
  assert.equal(parseIntegration(JSON.stringify({ ...base, category: 'Merch' }))?.category, 'Merch');
  assert.equal(parseIntegration(JSON.stringify(base))?.category, null);
  assert.equal(parseIntegration(JSON.stringify({ ...base, category: 'x'.repeat(100) }))?.category?.length, 40);
});
