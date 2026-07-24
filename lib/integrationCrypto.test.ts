import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptSecret,
  decryptSecret,
  IntegrationCryptoError,
  isIntegrationConfigError,
} from './integrationCrypto';

test('roundtrip', () => {
  const ct = encryptSecret('shpat_abc123');
  assert.notEqual(ct, 'shpat_abc123');
  assert.ok(ct.startsWith('v1:'));
  assert.equal(decryptSecret(ct), 'shpat_abc123');
});

test('unique IV per call', () => {
  assert.notEqual(encryptSecret('same'), encryptSecret('same'));
});

test('tampered ciphertext throws', () => {
  const ct = encryptSecret('secret');
  const parts = ct.split(':');
  parts[3] = Buffer.from('tampered-payload').toString('base64');
  assert.throws(() => decryptSecret(parts.join(':')));
});

test('malformed input throws', () => {
  assert.throws(() => decryptSecret('not-a-token'));
  assert.throws(() => decryptSecret('v2:a:b:c'));
});

// ── B1: config-class errors are typed + duck-typed so the push runner can tell
// a rotated/missing key from a transient Shopify/network blip ────────────────

test('isIntegrationConfigError discriminates config errors from ordinary errors', () => {
  assert.equal(isIntegrationConfigError(new IntegrationCryptoError('boom')), true);
  assert.equal(isIntegrationConfigError({ configError: true }), true, 'duck-typed marker survives bundle boundaries');
  assert.equal(isIntegrationConfigError(new Error('network reset')), false);
  assert.equal(isIntegrationConfigError(new TypeError('fetch failed')), false);
  assert.equal(isIntegrationConfigError(null), false);
  assert.equal(isIntegrationConfigError('string'), false);
});

test('malformed + tampered tokens throw a typed config error', () => {
  assert.throws(() => decryptSecret('not-a-token'), (e: unknown) => isIntegrationConfigError(e));
  const ct = encryptSecret('secret');
  const parts = ct.split(':');
  parts[3] = Buffer.from('tampered-payload').toString('base64');
  assert.throws(() => decryptSecret(parts.join(':')), (e: unknown) => isIntegrationConfigError(e));
});

test('missing/invalid INTEGRATION_TOKEN_KEY throws a typed config error', () => {
  const saved = process.env.INTEGRATION_TOKEN_KEY;
  try {
    delete process.env.INTEGRATION_TOKEN_KEY;
    assert.throws(() => encryptSecret('x'), (e: unknown) => isIntegrationConfigError(e));
    assert.throws(
      () => decryptSecret('v1:aa:bb:cc'),
      (e: unknown) => isIntegrationConfigError(e),
      'a well-formed token still fails config-class when the key is gone',
    );
    process.env.INTEGRATION_TOKEN_KEY = 'too-short';
    assert.throws(() => encryptSecret('x'), (e: unknown) => isIntegrationConfigError(e));
  } finally {
    if (saved === undefined) delete process.env.INTEGRATION_TOKEN_KEY;
    else process.env.INTEGRATION_TOKEN_KEY = saved;
  }
});
