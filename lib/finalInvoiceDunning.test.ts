// lib/finalInvoiceDunning.test.ts
//
// Pure decision tests for the final-invoice dunning heal-or-skip gate (M2/C3).
// Run: JWT_SECRET=test-secret-ci npx tsx --test lib/finalInvoiceDunning.test.ts
//
// The invariant under test: the dunning cron may ONLY email a buyer when their
// final-invoice PaymentIntent is retrievable AND definitively not paid.
//   • succeeded            → 'heal'  (buyer PAID — settle the stuck referral, never dun)
//   • definitively unpaid  → 'dun'   (requires_payment_method / canceled / no PI yet)
//   • in-flight payment    → 'skip'  (processing / requires_capture — buyer already
//                                     submitted payment; dunning risks double-billing)
//   • unknown / error      → 'skip'  (NEVER dun blind)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  finalInvoiceDunningAction,
  parseCheckoutSessionIdFromUrl,
} from './finalInvoiceDunning';

// ── heal: the buyer paid ────────────────────────────────────────────────────

test('succeeded → heal (paid buyer must be settled, never dunned)', () => {
  assert.equal(finalInvoiceDunningAction({ piStatus: 'succeeded' }), 'heal');
});

// ── dun: retrievable + definitively unpaid ──────────────────────────────────

test('requires_payment_method → dun', () => {
  assert.equal(finalInvoiceDunningAction({ piStatus: 'requires_payment_method' }), 'dun');
});

test('requires_confirmation → dun', () => {
  assert.equal(finalInvoiceDunningAction({ piStatus: 'requires_confirmation' }), 'dun');
});

test('requires_action → dun', () => {
  assert.equal(finalInvoiceDunningAction({ piStatus: 'requires_action' }), 'dun');
});

test('canceled → dun', () => {
  assert.equal(finalInvoiceDunningAction({ piStatus: 'canceled' }), 'dun');
});

test('no_payment_intent (Clover: session live, buyer never submitted payment) → dun', () => {
  assert.equal(finalInvoiceDunningAction({ piStatus: 'no_payment_intent' }), 'dun');
});

// ── skip: payment in flight (buyer already submitted — dunning could double-bill)

test('processing → skip (e.g. ACH in flight — buyer already paid, do not re-bill)', () => {
  assert.equal(finalInvoiceDunningAction({ piStatus: 'processing' }), 'skip');
});

test('requires_capture → skip (funds authorized — buyer already paid)', () => {
  assert.equal(finalInvoiceDunningAction({ piStatus: 'requires_capture' }), 'skip');
});

// ── skip: unknown payment state — never dun blind ───────────────────────────

test('undefined → skip', () => {
  assert.equal(finalInvoiceDunningAction({ piStatus: undefined }), 'skip');
});

test('null → skip', () => {
  assert.equal(finalInvoiceDunningAction({ piStatus: null }), 'skip');
});

test('empty string → skip', () => {
  assert.equal(finalInvoiceDunningAction({ piStatus: '' }), 'skip');
});

test('whitespace-only → skip', () => {
  assert.equal(finalInvoiceDunningAction({ piStatus: '   ' }), 'skip');
});

// ── parseCheckoutSessionIdFromUrl ───────────────────────────────────────────

test('parses live checkout session id from a stored Final Invoice URL', () => {
  assert.equal(
    parseCheckoutSessionIdFromUrl(
      'https://checkout.stripe.com/c/pay/cs_live_a1B2c3D4e5F6g7H8i9J0#fidkdWxOYHwnPyd1blpxYHZxWjA0',
    ),
    'cs_live_a1B2c3D4e5F6g7H8i9J0',
  );
});

test('parses test-mode session id', () => {
  assert.equal(
    parseCheckoutSessionIdFromUrl('https://checkout.stripe.com/c/pay/cs_test_abc123XYZ'),
    'cs_test_abc123XYZ',
  );
});

test('returns null for a URL without a session id', () => {
  assert.equal(parseCheckoutSessionIdFromUrl('https://buyhalfcow.com/member'), null);
});

test('returns null for empty / undefined / non-string input', () => {
  assert.equal(parseCheckoutSessionIdFromUrl(''), null);
  assert.equal(parseCheckoutSessionIdFromUrl(undefined), null);
  assert.equal(parseCheckoutSessionIdFromUrl(null), null);
  assert.equal(parseCheckoutSessionIdFromUrl(42), null);
});
