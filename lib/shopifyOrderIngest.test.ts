import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isBhcOriginOrder,
  extractOrderLineItems,
  orderDecrementPatch,
  shopifyOrderEventId,
} from './shopifyOrderIngest';

// ── Landmine 1: BHC's own pushed orders must be a NO-OP (already decremented at
// settlement — decrementing again double-counts) ────────────────────────────

test('BHC-tagged order → treated as BHC-origin (skip)', () => {
  assert.equal(isBhcOriginOrder({ tags: 'BHC' }), true);
  assert.equal(isBhcOriginOrder({ tags: 'gift, BHC, wholesale' }), true);
  assert.equal(isBhcOriginOrder({ tags: ['BHC'] }), true);
  assert.equal(isBhcOriginOrder({ source_name: 'BuyHalfCow' }), true);
  assert.equal(isBhcOriginOrder({ source_name: 'buyhalfcow' }), true, 'source_name normalization tolerated');
});

test('a genuine direct sale is NOT BHC-origin', () => {
  assert.equal(isBhcOriginOrder({ source_name: 'web', tags: '' }), false);
  assert.equal(isBhcOriginOrder({ source_name: 'pos', tags: 'vip' }), false);
  assert.equal(isBhcOriginOrder({}), false);
  assert.equal(isBhcOriginOrder({ tags: 'BHClub' }), false, 'substring must NOT false-match the exact BHC tag');
});

// ── Line-item extraction ─────────────────────────────────────────────────────

test('extractOrderLineItems keeps SKU + positive-qty rows only', () => {
  const items = extractOrderLineItems({
    line_items: [
      { sku: 'BEEF-BOX-10', quantity: 2 },
      { sku: '', quantity: 3 },          // no SKU → drop (can't join)
      { sku: 'JERKY-1', quantity: 0 },   // zero qty → drop
      { sku: 'STICK-1', quantity: '4' }, // stringy qty coerced
      { sku: '  PATTY-1  ', quantity: 1 }, // trimmed
    ],
  });
  assert.deepEqual(items, [
    { sku: 'BEEF-BOX-10', quantity: 2 },
    { sku: 'STICK-1', quantity: 4 },
    { sku: 'PATTY-1', quantity: 1 },
  ]);
});

test('extractOrderLineItems tolerates missing/garbage line_items', () => {
  assert.deepEqual(extractOrderLineItems({}), []);
  assert.deepEqual(extractOrderLineItems({ line_items: null }), []);
  assert.deepEqual(extractOrderLineItems(null), []);
});

// ── Landmine 2: decrement patch mirrors settlement (unlimited untouched, floor
// at 0, flip Active off at 0, never on) ──────────────────────────────────────

test('decrement: real count decrements by qty', () => {
  assert.deepEqual(orderDecrementPatch(10, 2), { 'Orders Left': 8 });
  assert.deepEqual(orderDecrementPatch('5', 1), { 'Orders Left': 4 });
});

test('decrement: hitting 0 flips Active off; floors at 0 on oversell', () => {
  assert.deepEqual(orderDecrementPatch(2, 2), { 'Orders Left': 0, Active: false });
  assert.deepEqual(orderDecrementPatch(1, 5), { 'Orders Left': 0, Active: false }, 'floors at 0');
});

test('decrement: unlimited stock (blank/null) is left untouched → null', () => {
  assert.equal(orderDecrementPatch('', 1), null);
  assert.equal(orderDecrementPatch(null, 1), null);
  assert.equal(orderDecrementPatch(undefined, 1), null);
  assert.equal(orderDecrementPatch('not-a-number', 1), null);
});

test('decrement: never flips Active ON when stock remains', () => {
  const patch = orderDecrementPatch(9, 1);
  assert.deepEqual(patch, { 'Orders Left': 8 });
  assert.ok(patch && !('Active' in patch), 'Active must not appear when stock remains (curation gate)');
});

test('decrement: zero/negative qty is a no-op', () => {
  assert.equal(orderDecrementPatch(5, 0), null);
  assert.equal(orderDecrementPatch(5, -3), null);
});

// ── Idempotency key stability (redelivery of the same order → same key) ──────

test('shopifyOrderEventId is stable per (shop, order id) and shop-namespaced', () => {
  assert.equal(shopifyOrderEventId('Ranch.myshopify.com', { id: 12345 }), 'shopify-order:ranch.myshopify.com:12345');
  assert.equal(
    shopifyOrderEventId('ranch.myshopify.com', { id: 12345 }),
    shopifyOrderEventId('ranch.myshopify.com', { id: 12345, foo: 'bar' }),
    'redelivery with extra fields → identical key',
  );
  assert.notEqual(
    shopifyOrderEventId('a.myshopify.com', { id: 1 }),
    shopifyOrderEventId('b.myshopify.com', { id: 1 }),
    'same order id on different shops → distinct keys',
  );
});

// ── Route-shape pins: the webhook handler + connect flow can't be unit-run
// under `tsx --test`, so pin their source shape (same technique as
// lib/referralLock.test.ts) — a silent revert on the money/inventory path
// surfaces here as a failure.
const webhookSrc = readFileSync(
  fileURLToPath(new URL('../app/api/webhooks/shopify/route.ts', import.meta.url)),
  'utf8',
);
const connectSrc = readFileSync(fileURLToPath(new URL('./shopifyConnectFlow.ts', import.meta.url)), 'utf8');

test('webhook handler routes orders/create and skips BHC-origin orders', () => {
  assert.match(webhookSrc, /topic === 'orders\/create'/, 'must handle the orders/create topic');
  assert.match(webhookSrc, /isBhcOriginOrder\(payload\)/, 'must skip BHC-pushed orders (no double-decrement)');
});

test('webhook handler is doubly idempotent (claimOnce + durable Stripe Events)', () => {
  assert.match(webhookSrc, /claimOnce\(`shopify-order-create:/, 'tight-race guard');
  assert.match(webhookSrc, /getFirstRecord\('Stripe Events'/, 'durable dedupe read');
  assert.match(webhookSrc, /createRecord\('Stripe Events'/, 'durable dedupe write');
  assert.match(webhookSrc, /'Status':\s*'processed'/, "must flip the durable marker to processed");
  assert.match(webhookSrc, /skipping decrement/, 'must bail SAFE if the durable store is unavailable');
});

test('webhook decrement is scoped to the rancher + uses the pure patch', () => {
  assert.match(webhookSrc, /\{Rancher Record ID\} = "\$\{escapeAirtableValue\(String\(rancher\.id\)\)\}"/, 'SKU query scoped to this rancher');
  assert.match(webhookSrc, /orderDecrementPatch\(row\['Orders Left'\], li\.quantity\)/, 'uses the tested decrement patch');
});

test('connect flow registers ORDERS_CREATE and alerts if it fails', () => {
  assert.match(connectSrc, /'ORDERS_CREATE'/, 'ORDERS_CREATE topic must be registered');
  assert.match(connectSrc, /ordersCreateDead/, 'a failed ORDERS_CREATE registration must be surfaced');
  assert.match(connectSrc, /oversell/i, 'the alert must name the oversell consequence');
});
