import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { verifyShopifyHmac } from './shopifyWebhookVerify';

test('valid signature passes; wrong secret / tampered body / malformed header fail', () => {
  const body = '{"id":1}';
  const secret = 'shhh';
  const sig = createHmac('sha256', secret).update(body, 'utf8').digest('base64');
  assert.equal(verifyShopifyHmac(body, sig, secret), true);
  assert.equal(verifyShopifyHmac(body, sig, 'wrong'), false);
  assert.equal(verifyShopifyHmac(body + 'x', sig, secret), false);
  assert.equal(verifyShopifyHmac(body, null, secret), false);
  assert.equal(verifyShopifyHmac(body, '', secret), false);
  assert.equal(verifyShopifyHmac(body, 'not-base64!!!!', secret), false);
  assert.equal(verifyShopifyHmac(body, sig, ''), false);
});
