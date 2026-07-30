// lib/smsTransport.test.ts — the provider resolver + the never-throw contract.
//
// The guardrail this pins: with NO new env set, BuyHalfCow sends through Twilio
// exactly as it did before the transport existed. A typo'd SMS_PROVIDER must
// fall back rather than silently killing the channel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSmsProvider, sendViaProvider, SMS_PROVIDERS } from './smsTransport';

// ─── resolveSmsProvider ────────────────────────────────────────────────────

test('resolveSmsProvider: unset env defaults to twilio (today behavior preserved)', () => {
  assert.equal(resolveSmsProvider({}), 'twilio');
  assert.equal(resolveSmsProvider({ SMS_PROVIDER: undefined }), 'twilio');
});

test('resolveSmsProvider: blank / whitespace-only defaults to twilio', () => {
  assert.equal(resolveSmsProvider({ SMS_PROVIDER: '' }), 'twilio');
  assert.equal(resolveSmsProvider({ SMS_PROVIDER: '   ' }), 'twilio');
});

test('resolveSmsProvider: every known provider resolves to itself', () => {
  for (const p of SMS_PROVIDERS) {
    assert.equal(resolveSmsProvider({ SMS_PROVIDER: p }), p);
  }
});

test('resolveSmsProvider: case-insensitive + trims', () => {
  assert.equal(resolveSmsProvider({ SMS_PROVIDER: 'TELNYX' }), 'telnyx');
  assert.equal(resolveSmsProvider({ SMS_PROVIDER: ' Plivo ' }), 'plivo');
  assert.equal(resolveSmsProvider({ SMS_PROVIDER: 'BandWidth' }), 'bandwidth');
});

test('resolveSmsProvider: unknown value falls back to twilio, never throws', () => {
  assert.equal(resolveSmsProvider({ SMS_PROVIDER: 'vonage' }), 'twilio');
  assert.equal(resolveSmsProvider({ SMS_PROVIDER: 'twillio' }), 'twilio'); // classic typo
  assert.equal(resolveSmsProvider({ SMS_PROVIDER: '0' }), 'twilio');
});

test('resolveSmsProvider: defaults to reading process.env', () => {
  const prev = process.env.SMS_PROVIDER;
  try {
    delete process.env.SMS_PROVIDER;
    assert.equal(resolveSmsProvider(), 'twilio');
    process.env.SMS_PROVIDER = 'telnyx';
    assert.equal(resolveSmsProvider(), 'telnyx');
  } finally {
    if (prev === undefined) delete process.env.SMS_PROVIDER;
    else process.env.SMS_PROVIDER = prev;
  }
});

// ─── sendViaProvider: never throws, tags every result with the provider ────

test('sendViaProvider: invalid phone returns ok:false, no vendor call', async () => {
  let called = 0;
  const res = await sendViaProvider(
    { to: 'not-a-phone', body: 'hi' },
    {
      env: { SMS_PROVIDER: 'telnyx', TELNYX_API_KEY: 'k', TELNYX_FROM: '+15550001111' },
      fetchImpl: (async () => { called++; return new Response('{}'); }) as any,
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.provider, 'telnyx');
  assert.match(String(res.error), /invalid phone/i);
  assert.equal(called, 0, 'must not hit the vendor with a junk number');
});

test('sendViaProvider: missing credentials return ok:false for every provider', async () => {
  let called = 0;
  const fetchImpl = (async () => { called++; return new Response('{}'); }) as any;
  for (const p of SMS_PROVIDERS) {
    const res = await sendViaProvider(
      { to: '5551234567', body: 'hi' },
      { env: { SMS_PROVIDER: p }, fetchImpl },
    );
    assert.equal(res.ok, false, `${p} should refuse without creds`);
    assert.equal(res.provider, p);
    assert.ok(res.error && res.error.length > 0, `${p} should explain itself`);
  }
  assert.equal(called, 0, 'no credential = no network call');
});

test('sendViaProvider: normalizes a bare 10-digit US number to E.164 before sending', async () => {
  let sentTo = '';
  const res = await sendViaProvider(
    { to: '(555) 123-4567', body: 'hi' },
    {
      env: { SMS_PROVIDER: 'telnyx', TELNYX_API_KEY: 'k', TELNYX_FROM: '+15550001111' },
      fetchImpl: (async (_url: string, init: any) => {
        sentTo = JSON.parse(init.body).to;
        return new Response(JSON.stringify({ data: { id: 'm1' } }), { status: 200 });
      }) as any,
    },
  );
  assert.equal(res.ok, true);
  assert.equal(sentTo, '+15551234567');
});

test('sendViaProvider: a throwing fetch is contained — returns ok:false, does not reject', async () => {
  const res = await sendViaProvider(
    { to: '+15551234567', body: 'hi' },
    {
      env: { SMS_PROVIDER: 'plivo', PLIVO_AUTH_ID: 'a', PLIVO_AUTH_TOKEN: 't', PLIVO_FROM: '+15550001111' },
      fetchImpl: (async () => { throw new Error('ECONNRESET'); }) as any,
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.provider, 'plivo');
  assert.match(String(res.error), /ECONNRESET/);
});

test('sendViaProvider: unknown SMS_PROVIDER routes to twilio (and twilio refuses without creds)', async () => {
  const res = await sendViaProvider(
    { to: '+15551234567', body: 'hi' },
    { env: { SMS_PROVIDER: 'nexmo' } },
  );
  assert.equal(res.provider, 'twilio');
  assert.equal(res.ok, false);
});
