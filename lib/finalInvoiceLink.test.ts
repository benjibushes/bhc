import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mintFinalInvoiceLinkToken,
  verifyFinalInvoiceLinkToken,
  FINAL_INVOICE_GRANT_PURPOSE,
} from './finalInvoiceLink';
import { mintDepositGrantToken } from './campaignReserve';
import { parseCheckoutSessionIdFromUrl } from './finalInvoiceDunning';

test('mint → verify roundtrip pins the referral', () => {
  const token = mintFinalInvoiceLinkToken({ referralId: 'recOlGI4mMdSDsz9V' });
  const verified = verifyFinalInvoiceLinkToken(token);
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.payload.referralId, 'recOlGI4mMdSDsz9V');
    assert.equal(verified.payload.purpose, FINAL_INVOICE_GRANT_PURPOSE);
  }
});

test('mint throws on missing referralId', () => {
  assert.throws(() => mintFinalInvoiceLinkToken({ referralId: '' }));
  assert.throws(() => mintFinalInvoiceLinkToken({ referralId: '   ' }));
});

test('verify rejects missing / empty tokens', () => {
  assert.deepEqual(verifyFinalInvoiceLinkToken(null), { ok: false, reason: 'missing' });
  assert.deepEqual(verifyFinalInvoiceLinkToken(undefined), { ok: false, reason: 'missing' });
  assert.deepEqual(verifyFinalInvoiceLinkToken(''), { ok: false, reason: 'missing' });
});

test('verify rejects tampered tokens', () => {
  const token = mintFinalInvoiceLinkToken({ referralId: 'recAAAAAAAAAAAAAA' });
  const tampered = token.slice(0, -4) + 'zzzz';
  const verified = verifyFinalInvoiceLinkToken(tampered);
  assert.equal(verified.ok, false);
});

test('verify rejects oversized tokens without burning CPU on jwt.verify', () => {
  const verified = verifyFinalInvoiceLinkToken('x'.repeat(5000));
  assert.deepEqual(verified, { ok: false, reason: 'invalid' });
});

test('a deposit-grant token must NOT open the final-invoice rail', () => {
  const depositGrant = mintDepositGrantToken({
    consumerId: 'recCCCCCCCCCCCCCC',
    referralId: 'recRRRRRRRRRRRRRR',
  });
  const verified = verifyFinalInvoiceLinkToken(depositGrant);
  assert.equal(verified.ok, false);
  if (!verified.ok) assert.equal(verified.reason, 'wrong-purpose');
});

// Regression guard for the dunning heal-or-skip gate: a durable /r/f URL
// stored in 'Final Invoice URL' carries no cs_ id, so the resolver MUST get
// the session from 'Final Invoice Checkout Session Id' — parsing the URL
// returns null by design and must not be treated as an error.
test('durable /r/f URLs parse to no session id (resolver uses the stamped field)', () => {
  assert.equal(
    parseCheckoutSessionIdFromUrl('https://www.buyhalfcow.com/r/f/eyJhbGciOi.abc.def'),
    null,
  );
  // Legacy rows (pre-durable) still parse.
  assert.equal(
    parseCheckoutSessionIdFromUrl('https://checkout.stripe.com/c/pay/cs_live_a1B2c3D4#frag'),
    'cs_live_a1B2c3D4',
  );
});
