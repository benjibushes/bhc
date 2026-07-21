import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPushableOrder, buildPushInput } from './fulfillmentPush';

const cfg = { v: 1, provider: 'shopify', shop: 'x.myshopify.com', encToken: 'e', encApiSecret: 'e', mode: 'manual', markupPercent: null, locationId: null } as any;
const baseOrder = {
  id: 'recORDER', 'Order Ref': 'Beef Box — Jane Doe', Status: 'New', Quantity: 2,
  'Buyer Name': 'Jane Doe', 'Buyer Email': 'j@x.com', 'Ship To Address': 'Jane Doe\n123 Main St\nAustin, TX, 78701',
  'External Push Status': '', 'External Order Id': '',
};
const product = { id: 'recPROD', 'External SKU': 'BEEF-BOX-10', 'Product Name': 'Beef Box' };

test('happy path is pushable', () => {
  assert.deepEqual(selectPushableOrder({ order: baseOrder, product, integration: cfg }), { ok: true });
});

test('blocked: no integration', () => {
  const r = selectPushableOrder({ order: baseOrder, product, integration: null });
  assert.deepEqual(r, { ok: false, reason: 'no-integration' });
});

test('blocked: deposit-style and pickup Order Ref prefixes', () => {
  assert.equal((selectPushableOrder({ order: { ...baseOrder, 'Order Ref': 'DEPOSIT — Beef Box — Jane' }, product, integration: cfg }) as any).reason, 'deposit-style');
  assert.equal((selectPushableOrder({ order: { ...baseOrder, 'Order Ref': 'PICKUP — Beef Box — Jane' }, product, integration: cfg }) as any).reason, 'pickup');
});

test('blocked: missing SKU / already pushed / non-New status / no address', () => {
  assert.equal((selectPushableOrder({ order: baseOrder, product: { ...product, 'External SKU': '' }, integration: cfg }) as any).reason, 'no-sku');
  assert.equal((selectPushableOrder({ order: baseOrder, product: {}, integration: cfg }) as any).reason, 'no-sku');
  assert.equal((selectPushableOrder({ order: { ...baseOrder, 'External Order Id': 'gid://shopify/Order/1' }, product, integration: cfg }) as any).reason, 'already-pushed');
  assert.equal((selectPushableOrder({ order: { ...baseOrder, 'External Push Status': 'pushed' }, product, integration: cfg }) as any).reason, 'already-pushed');
  assert.equal((selectPushableOrder({ order: { ...baseOrder, Status: 'Refunded' }, product, integration: cfg }) as any).reason, 'status-Refunded');
  assert.equal((selectPushableOrder({ order: { ...baseOrder, Status: 'Shipped' }, product, integration: cfg }) as any).reason, 'status-Shipped');
  assert.equal((selectPushableOrder({ order: { ...baseOrder, 'Ship To Address': ' ' }, product, integration: cfg }) as any).reason, 'no-address');
});

test('failed:<error> stamps do NOT block a retry (only pushed/order-id do)', () => {
  const r = selectPushableOrder({ order: { ...baseOrder, 'External Push Status': 'failed: http 500' }, product, integration: cfg });
  assert.deepEqual(r, { ok: true });
});

test('buildPushInput maps fields + quantity', () => {
  const input = buildPushInput(baseOrder, product);
  assert.equal(input.orderRef, 'Beef Box — Jane Doe');
  assert.equal(input.buyerEmail, 'j@x.com');
  assert.deepEqual(input.lineItems, [{ sku: 'BEEF-BOX-10', quantity: 2, title: 'Beef Box' }]);
});

test('buildPushInput defaults quantity 1 and trims SKU', () => {
  const input = buildPushInput({ ...baseOrder, Quantity: undefined }, { ...product, 'External SKU': ' BEEF-BOX-10 ' });
  assert.equal(input.lineItems[0].quantity, 1);
  assert.equal(input.lineItems[0].sku, 'BEEF-BOX-10');
});

test('exact markers only: a product NAMED Deposit/Pickup is not blocked', () => {
  const cfg2 = { v: 1, provider: 'shopify', shop: 'x.myshopify.com', encToken: 'e', encApiSecret: 'e', mode: 'manual', markupPercent: null, locationId: null } as any;
  const order = {
    id: 'recX', 'Order Ref': 'Deposit Jar Candle — Jane Doe', Status: 'New', Quantity: 1,
    'Buyer Name': 'Jane', 'Buyer Email': 'j@x.com', 'Ship To Address': 'J\n1 St\nAustin, TX, 78701',
    'External Push Status': '', 'External Order Id': '',
  };
  const product2 = { id: 'recP', 'External SKU': 'CANDLE-1', 'Product Name': 'Deposit Jar Candle' };
  assert.deepEqual(selectPushableOrder({ order, product: product2, integration: cfg2 }), { ok: true });
});
