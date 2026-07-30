// lib/smsInboundAuth.test.ts — the neutral inbound webhook's shared-secret gate.
//
// This endpoint can flip a Consumer's Unsubscribed / SMS Opt-In flags, so an
// anonymous prod deploy is not an option: no secret in production = 503, not
// "wave everyone through".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySmsInboundToken, safeEqual } from './smsInboundAuth';

test('correct token is accepted', () => {
  assert.equal(verifySmsInboundToken('s3cr3t', { SMS_INBOUND_SECRET: 's3cr3t' }), 'ok');
});

test('wrong token is forbidden', () => {
  assert.equal(verifySmsInboundToken('nope', { SMS_INBOUND_SECRET: 's3cr3t' }), 'forbidden');
});

test('missing / empty token is forbidden when a secret IS configured', () => {
  assert.equal(verifySmsInboundToken(null, { SMS_INBOUND_SECRET: 's3cr3t' }), 'forbidden');
  assert.equal(verifySmsInboundToken(undefined, { SMS_INBOUND_SECRET: 's3cr3t' }), 'forbidden');
  assert.equal(verifySmsInboundToken('', { SMS_INBOUND_SECRET: 's3cr3t' }), 'forbidden');
});

test('a token that is a PREFIX of the secret is forbidden (length is compared)', () => {
  assert.equal(verifySmsInboundToken('s3c', { SMS_INBOUND_SECRET: 's3cr3t' }), 'forbidden');
  assert.equal(verifySmsInboundToken('s3cr3tt', { SMS_INBOUND_SECRET: 's3cr3t' }), 'forbidden');
});

test('secret unset in PRODUCTION fails closed (misconfigured → 503)', () => {
  assert.equal(verifySmsInboundToken('anything', { NODE_ENV: 'production' }), 'misconfigured');
  assert.equal(verifySmsInboundToken('anything', { NODE_ENV: 'production', SMS_INBOUND_SECRET: '' }), 'misconfigured');
  assert.equal(verifySmsInboundToken('anything', { NODE_ENV: 'production', SMS_INBOUND_SECRET: '   ' }), 'misconfigured');
});

test('secret unset OUTSIDE production allows local curl testing', () => {
  assert.equal(verifySmsInboundToken(null, { NODE_ENV: 'development' }), 'ok');
  assert.equal(verifySmsInboundToken(null, {}), 'ok');
});

test('a padded secret is trimmed so a stray newline in the env does not brick inbound', () => {
  assert.equal(verifySmsInboundToken('s3cr3t', { SMS_INBOUND_SECRET: ' s3cr3t ' }), 'ok');
});

test('safeEqual: true only on exact match, never throws on length mismatch', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual('a', ''), false);
});
