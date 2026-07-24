import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeWebhookFailures } from './shopifyConnectFlow';

// The webhook-registration-failure alert (batch F, audit #14) must NAME each
// failed topic and its consequence — a lone APP_UNINSTALLED / PRODUCTS_* failure
// used to be silent under #468 (which only covered FULFILLMENTS + ORDERS_CREATE).

test('describeWebhookFailures: names each failed topic with its consequence', () => {
  const out = describeWebhookFailures([
    'APP_UNINSTALLED: Throttled',
    'PRODUCTS_UPDATE: scope missing',
  ]);
  assert.match(out, /APP_UNINSTALLED/);
  assert.match(out, /uninstall backstop/i);
  assert.match(out, /PRODUCTS_UPDATE/);
  assert.match(out, /stale price|oversell/i);
  // one bullet per failed topic
  assert.equal(out.split('\n').length, 2);
});

test('describeWebhookFailures: parses topic from "TOPIC: msg" shape', () => {
  const out = describeWebhookFailures(['ORDERS_CREATE: address already taken']);
  assert.match(out, /^• ORDERS_CREATE — /);
  assert.match(out, /oversell/i);
});

test('describeWebhookFailures: FULFILLMENTS topics explain the tracking break', () => {
  const create = describeWebhookFailures(['FULFILLMENTS_CREATE: boom']);
  assert.match(create, /tracking will NOT flow back/i);
  const update = describeWebhookFailures(['FULFILLMENTS_UPDATE: boom']);
  assert.match(update, /shipment status/i);
});

test('describeWebhookFailures: unknown topic falls back to a generic consequence', () => {
  const out = describeWebhookFailures(['SOME_FUTURE_TOPIC: whatever']);
  assert.match(out, /• SOME_FUTURE_TOPIC — real-time SOME_FUTURE_TOPIC events will not reach BHC/);
});

test('describeWebhookFailures: empty list → empty string', () => {
  assert.equal(describeWebhookFailures([]), '');
});
