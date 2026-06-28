import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorizedCron, requireCron } from './cronAuth';

// secrets.ts calls requireEnv('CRON_SECRET') at import (fail-loud), so this
// suite must be run with CRON_SECRET set, e.g.:
//   CRON_SECRET=test-cron-secret npx tsx --test lib/cronAuth.test.ts
const SECRET = process.env.CRON_SECRET ?? 'test-cron-secret';

function reqWithAuth(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) headers.set('authorization', value);
  return new Request('https://buyhalfcow.com/api/cron/x', { headers });
}

test('accepts the correct Bearer token', () => {
  assert.equal(isAuthorizedCron(reqWithAuth(`Bearer ${SECRET}`)), true);
});

test('rejects a wrong token', () => {
  assert.equal(isAuthorizedCron(reqWithAuth('Bearer wrong')), false);
});

test('rejects a missing Authorization header (fail-closed)', () => {
  assert.equal(isAuthorizedCron(reqWithAuth(null)), false);
});

test('rejects an empty Authorization header', () => {
  assert.equal(isAuthorizedCron(reqWithAuth('')), false);
});

test('rejects a token with the wrong scheme prefix', () => {
  assert.equal(isAuthorizedCron(reqWithAuth(`Basic ${SECRET}`)), false);
  assert.equal(isAuthorizedCron(reqWithAuth(SECRET)), false);
});

test('does NOT accept the secret via ?secret= query param', () => {
  const req = new Request(
    `https://buyhalfcow.com/api/cron/x?secret=${encodeURIComponent(SECRET)}`,
  );
  assert.equal(isAuthorizedCron(req), false);
});

test('rejects a Bearer token that is a prefix of the secret (length-safe)', () => {
  assert.equal(isAuthorizedCron(reqWithAuth(`Bearer ${SECRET.slice(0, -1)}`)), false);
  assert.equal(isAuthorizedCron(reqWithAuth(`Bearer ${SECRET}-extra`)), false);
});

test('requireCron returns null when authorized', () => {
  assert.equal(requireCron(reqWithAuth(`Bearer ${SECRET}`)), null);
});

test('requireCron returns a 401 Response when unauthorized', async () => {
  const res = requireCron(reqWithAuth('Bearer nope'));
  assert.ok(res instanceof Response);
  assert.equal(res!.status, 401);
  const body = await res!.json();
  assert.deepEqual(body, { error: 'Unauthorized' });
});
