import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret } from './integrationCrypto';

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
