import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDepositConsent } from './depositConsent';

// F2/A4 — the ONLY hard consent gate on the money path is the 400 when
// termsAccepted is missing on a NEW deposit-checkout create. These tests pin
// the exact acceptance semantics: strict boolean true, nothing coerced. A
// chargeback rebuttal cites this record — "truthy" is not "agreed".

test('accepts strict boolean true', () => {
  assert.equal(validateDepositConsent({ termsAccepted: true }), true);
});

test('accepts true alongside the normal deposit body fields', () => {
  assert.equal(
    validateDepositConsent({ referralId: 'recABC', cutSize: 'half', termsAccepted: true }),
    true,
  );
});

test('rejects missing termsAccepted (legacy/forged body)', () => {
  assert.equal(validateDepositConsent({ referralId: 'recABC', cutSize: 'half' }), false);
});

test('rejects explicit false', () => {
  assert.equal(validateDepositConsent({ termsAccepted: false }), false);
});

test('rejects truthy non-boolean coercions', () => {
  assert.equal(validateDepositConsent({ termsAccepted: 'true' }), false);
  assert.equal(validateDepositConsent({ termsAccepted: 1 }), false);
  assert.equal(validateDepositConsent({ termsAccepted: {} }), false);
});

test('rejects non-object bodies', () => {
  assert.equal(validateDepositConsent(null), false);
  assert.equal(validateDepositConsent(undefined), false);
  assert.equal(validateDepositConsent('termsAccepted'), false);
  assert.equal(validateDepositConsent([true]), false);
});
