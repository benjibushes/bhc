// lib/productOrderTermination.test.ts
//
// The money rules for cancelling/refunding a product order, red-first. Every
// refusal here is a mistake that costs real money or real trust:
// double-refunding, refunding a box already in a truck, or flipping a row
// while the charge stays put.
//
// Runner: npx tsx --test lib/productOrderTermination.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTermination } from './productOrderTermination';

const live = (over: Record<string, unknown> = {}) => ({
  status: 'New',
  shippedAt: '',
  stripePaymentIntent: 'pi_test_123',
  ...over,
});

test('a live New order can be cancelled → records Cancelled', () => {
  const d = decideTermination(live(), 'cancel');
  assert.equal(d.ok, true);
  if (d.ok) {
    assert.equal(d.terminalStatus, 'Cancelled');
    assert.equal(d.action, 'cancel');
    assert.equal(d.piId, 'pi_test_123');
  }
});

test('a live New order can be refunded → records Refunded (a DISTINCT state)', () => {
  const d = decideTermination(live(), 'refund');
  assert.equal(d.ok, true);
  if (d.ok) assert.equal(d.terminalStatus, 'Refunded');
});

test('an unknown action never moves money', () => {
  for (const action of ['', 'REFUNDD', 'delete', null, undefined, 42, {}]) {
    const d = decideTermination(live(), action);
    assert.equal(d.ok, false, String(action));
    if (!d.ok) {
      assert.equal(d.code, 'bad-action');
      assert.equal(d.status, 400);
    }
  }
});

test('case-insensitive action verbs still work (UI casing must not lose money)', () => {
  assert.equal(decideTermination(live(), 'CANCEL').ok, true);
  assert.equal(decideTermination(live(), ' Refund ').ok, true);
});

test('NO DOUBLE REFUND: an already-terminal order refuses for both verbs', () => {
  for (const status of ['Refunded', 'Cancelled', 'Canceled']) {
    for (const action of ['cancel', 'refund']) {
      const d = decideTermination(live({ status }), action);
      assert.equal(d.ok, false, `${status}/${action}`);
      if (!d.ok) {
        assert.equal(d.code, 'already-terminal');
        assert.equal(d.status, 409);
      }
    }
  }
});

test('NO REFUNDING A SHIPPED BOX: Status Shipped/Delivered refuses', () => {
  for (const status of ['Shipped', 'Delivered']) {
    const d = decideTermination(live({ status }), 'cancel');
    assert.equal(d.ok, false, status);
    if (!d.ok) assert.equal(d.code, 'already-shipped');
  }
});

test('a Shipped At stamp alone refuses, even if Status still says New', () => {
  const d = decideTermination(live({ status: 'New', shippedAt: '2026-08-01T00:00:00.000Z' }), 'cancel');
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, 'already-shipped');
});

test('already-terminal outranks already-shipped (never re-refund a shipped refund)', () => {
  const d = decideTermination(live({ status: 'Refunded', shippedAt: '2026-08-01T00:00:00.000Z' }), 'refund');
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, 'already-terminal');
});

test('FAIL CLOSED: no payment intent ⇒ refuse rather than flip a row and lie', () => {
  for (const pi of ['', '   ', null, undefined]) {
    const d = decideTermination(live({ stripePaymentIntent: pi }), 'cancel');
    assert.equal(d.ok, false, String(pi));
    if (!d.ok) {
      assert.equal(d.code, 'no-payment-intent');
      assert.equal(d.status, 409);
    }
  }
});

test('a blank/unknown Status is treated as live (settlement writes New)', () => {
  assert.equal(decideTermination(live({ status: '' }), 'cancel').ok, true);
  assert.equal(decideTermination(live({ status: 'Awaiting Something' }), 'cancel').ok, true);
});

test('every refusal carries buyer-safe words, never a stack trace', () => {
  const refusals = [
    decideTermination(live({ status: 'Refunded' }), 'cancel'),
    decideTermination(live({ status: 'Shipped' }), 'cancel'),
    decideTermination(live({ stripePaymentIntent: '' }), 'cancel'),
  ];
  for (const r of refusals) {
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.message.length > 20, r.message);
      assert.doesNotMatch(r.message, /undefined|null|Error/);
    }
  }
});
