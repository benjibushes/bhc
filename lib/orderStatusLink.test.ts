// lib/orderStatusLink.test.ts
//
// The buyer order-status link credential (shop-chain audit 2026-08-01). The
// contract that matters: only OUR token opens the page, a raw record id never
// does, and every failure mode is a discriminated result rather than a throw
// (the page must render an honest card, never a 500).
//
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/orderStatusLink.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {
  mintOrderStatusToken,
  verifyOrderStatusToken,
  orderStatusPath,
  orderStatusUrlFor,
  ORDER_STATUS_PURPOSE,
} from './orderStatusLink';

const SECRET = process.env.JWT_SECRET || 'test-secret-ci';
const ORDER = 'recAAAAAAAAAAAAAA';

test('mint → verify roundtrip returns the order id', () => {
  const v = verifyOrderStatusToken(mintOrderStatusToken({ orderId: ORDER }));
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.payload.orderId, ORDER);
    assert.equal(v.payload.purpose, ORDER_STATUS_PURPOSE);
  }
});

test('mint refuses a non-record-id so a broken email cannot ship a dead link', () => {
  assert.throws(() => mintOrderStatusToken({ orderId: '' }));
  assert.throws(() => mintOrderStatusToken({ orderId: 'not-an-id' }));
  assert.throws(() => mintOrderStatusToken({ orderId: 'rec123' }));
});

test('a RAW record id is not a credential — the page cannot be opened by guessing', () => {
  const v = verifyOrderStatusToken(ORDER);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, 'invalid');
});

test('missing / oversized / tampered tokens all refuse without throwing', () => {
  assert.deepEqual(verifyOrderStatusToken(null), { ok: false, reason: 'missing' });
  assert.deepEqual(verifyOrderStatusToken(''), { ok: false, reason: 'missing' });
  assert.deepEqual(verifyOrderStatusToken('x'.repeat(5000)), { ok: false, reason: 'invalid' });
  const good = mintOrderStatusToken({ orderId: ORDER });
  const tampered = good.slice(0, -3) + 'AAA';
  assert.equal(verifyOrderStatusToken(tampered).ok, false);
});

test('an expired token refuses (invalid), never opens', () => {
  const expired = jwt.sign({ purpose: ORDER_STATUS_PURPOSE, orderId: ORDER }, SECRET, { expiresIn: '-1s' });
  const v = verifyOrderStatusToken(expired);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, 'invalid');
});

test('CONFUSED-DEPUTY FENCE: another purpose signed with the same secret is rejected', () => {
  for (const purpose of ['campaign-reserve', 'deposit-grant', 'broker-reserve', 'member-session']) {
    const other = jwt.sign({ purpose, orderId: ORDER, consumerId: 'recX', referralId: 'recY' }, SECRET);
    const v = verifyOrderStatusToken(other);
    assert.equal(v.ok, false, `${purpose} must not open the order page`);
    if (!v.ok) assert.equal(v.reason, 'wrong-purpose');
  }
});

test('a token whose orderId claim is garbage refuses even when correctly signed', () => {
  const bad = jwt.sign({ purpose: ORDER_STATUS_PURPOSE, orderId: 'nope' }, SECRET);
  assert.deepEqual(verifyOrderStatusToken(bad), { ok: false, reason: 'invalid' });
});

test('orderStatusPath is url-safe and rooted at /order', () => {
  const token = mintOrderStatusToken({ orderId: ORDER });
  assert.equal(orderStatusPath(token), `/order/${token}`);
  assert.equal(orderStatusPath('a/b?c'), '/order/a%2Fb%3Fc');
});

test('orderStatusUrlFor builds an absolute link and never throws on a bad id', () => {
  const url = orderStatusUrlFor(ORDER, 'https://example.test/');
  assert.ok(url.startsWith('https://example.test/order/'), url);
  const v = verifyOrderStatusToken(url.split('/order/')[1]);
  assert.equal(v.ok, true);
  // Bad id → empty string, so callers render nothing rather than a dead link.
  assert.equal(orderStatusUrlFor('garbage', 'https://example.test'), '');
});
