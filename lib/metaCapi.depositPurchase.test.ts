// DEPOSIT-LEVEL META CONVERSION (2026-07-04) — pins the pure decision surface
// for the deposit Purchase: the env gate, the distinct event_id scheme, and the
// close-vs-deposit dedup guard that makes a tier_v2 deposit deal count ONCE.
//
// These are the load-bearing predicates. Getting the dedup guard wrong either
// double-counts every deposit deal in Meta (deposit Purchase + close Purchase)
// or drops the conversion for legacy no-deposit closes — both corrupt the ROAS
// signal the ad algorithm optimizes on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  depositPurchaseEnabled,
  depositEventId,
  shouldFireClosePurchase,
} from './metaCapi';

// ── depositPurchaseEnabled: env-gated dark, mirrors closePurchaseEnabled ──
test('depositPurchaseEnabled is false unless META_DEPOSIT_PURCHASE_ENABLED === "true"', () => {
  const prev = process.env.META_DEPOSIT_PURCHASE_ENABLED;
  try {
    delete process.env.META_DEPOSIT_PURCHASE_ENABLED;
    assert.equal(depositPurchaseEnabled(), false);
    process.env.META_DEPOSIT_PURCHASE_ENABLED = 'false';
    assert.equal(depositPurchaseEnabled(), false);
    process.env.META_DEPOSIT_PURCHASE_ENABLED = '1';
    assert.equal(depositPurchaseEnabled(), false, 'only the exact string "true" enables it');
    process.env.META_DEPOSIT_PURCHASE_ENABLED = 'TRUE';
    assert.equal(depositPurchaseEnabled(), false, 'case-sensitive — "TRUE" does not enable');
    process.env.META_DEPOSIT_PURCHASE_ENABLED = 'true';
    assert.equal(depositPurchaseEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.META_DEPOSIT_PURCHASE_ENABLED;
    else process.env.META_DEPOSIT_PURCHASE_ENABLED = prev;
  }
});

// ── depositEventId: distinct from the raw referral id used by close/InitiateCheckout ──
test('depositEventId prefixes so it never collides with the Closed-Won Purchase event_id', () => {
  assert.equal(depositEventId('recABC123'), 'deposit_recABC123');
  // The Closed-Won Purchase + deposit InitiateCheckout use the RAW id
  // (metaEventId(id) === id). Same event_name='Purchase' with the same id would
  // let Meta's dedup window mask a double-count — so it MUST differ.
  assert.notEqual(depositEventId('recABC123'), 'recABC123');
});

// ── shouldFireClosePurchase: THE dedup guard (deposit vs close) ──
test('flag OFF → close Purchase always fires (no deposit Purchase exists to dedup against)', () => {
  assert.equal(
    shouldFireClosePurchase({ depositPurchaseEnabled: false, depositPaidAt: '2026-07-04T00:00:00Z' }),
    true,
    'even with a deposit stamp, a disabled deposit flag means nothing fired at deposit',
  );
  assert.equal(
    shouldFireClosePurchase({ depositPurchaseEnabled: false, depositPaidAt: null }),
    true,
  );
});

test('flag ON + deposit paid → SUPPRESS close Purchase (deposit already counted, count once)', () => {
  assert.equal(
    shouldFireClosePurchase({ depositPurchaseEnabled: true, depositPaidAt: '2026-07-04T00:00:00Z' }),
    false,
  );
});

test('flag ON + NO deposit (legacy close) → close Purchase still fires (its only conversion)', () => {
  assert.equal(
    shouldFireClosePurchase({ depositPurchaseEnabled: true, depositPaidAt: null }),
    true,
  );
  assert.equal(
    shouldFireClosePurchase({ depositPurchaseEnabled: true, depositPaidAt: undefined }),
    true,
  );
  assert.equal(
    shouldFireClosePurchase({ depositPurchaseEnabled: true, depositPaidAt: '   ' }),
    true,
    'a blank/whitespace stamp is not proof of a paid deposit',
  );
});
