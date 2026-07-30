// lib/smsProviders/adapters.test.ts — every adapter's wire format, pinned.
//
// These assertions encode what the vendors' own docs say (all fetched
// 2026-07-30 — see the header comment in each adapter for the URL). If a doc
// changes, a test here should change with it; nobody should be re-deriving a
// request shape from memory at 2am with a dark SMS channel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendViaTelnyx } from './telnyx';
import { sendViaPlivo } from './plivo';
import { sendViaBandwidth } from './bandwidth';
import { sendViaTwilio } from './twilio';

type Captured = { url: string; init: any };

/** Fake fetch that records the call and replies with the given status + JSON. */
function fakeFetch(status: number, body: unknown, sink: Captured[]) {
  return (async (url: string, init: any) => {
    sink.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;
}

const TO = '+15559876543';

// ─── Telnyx ────────────────────────────────────────────────────────────────
// POST https://api.telnyx.com/v2/messages · Bearer · { from, to, text } · data.id

test('telnyx: URL, bearer auth and {from,to,text} body match the docs', async () => {
  const calls: Captured[] = [];
  const res = await sendViaTelnyx(
    { to: TO, body: 'Hello, world!' },
    {
      env: { TELNYX_API_KEY: 'KEY123', TELNYX_FROM: '+15551234567' },
      fetchImpl: fakeFetch(200, { data: { id: 'b0c7e8cb-6227' } }, calls),
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telnyx.com/v2/messages');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer KEY123');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    from: '+15551234567',
    to: TO,
    text: 'Hello, world!',
  });
  assert.deepEqual(res, { ok: true, provider: 'telnyx', providerMessageId: 'b0c7e8cb-6227' });
});

test('telnyx: per-send `from` overrides TELNYX_FROM', async () => {
  const calls: Captured[] = [];
  await sendViaTelnyx(
    { to: TO, body: 'x', from: '+15557778888' },
    { env: { TELNYX_API_KEY: 'k', TELNYX_FROM: '+15551234567' }, fetchImpl: fakeFetch(200, { data: { id: 'i' } }, calls) },
  );
  assert.equal(JSON.parse(calls[0].init.body).from, '+15557778888');
});

test('telnyx: 4xx surfaces the vendor error and returns ok:false', async () => {
  const calls: Captured[] = [];
  const res = await sendViaTelnyx(
    { to: TO, body: 'x' },
    {
      env: { TELNYX_API_KEY: 'k', TELNYX_FROM: '+1555' },
      fetchImpl: fakeFetch(422, { errors: [{ code: '10015', title: 'Invalid from', detail: 'not on account' }] }, calls),
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.provider, 'telnyx');
  assert.match(String(res.error), /422/);
  assert.match(String(res.error), /Invalid from: not on account/);
});

test('telnyx: missing credentials short-circuit before any network call', async () => {
  const calls: Captured[] = [];
  const noKey = await sendViaTelnyx({ to: TO, body: 'x' }, { env: { TELNYX_FROM: '+1555' }, fetchImpl: fakeFetch(200, {}, calls) });
  const noFrom = await sendViaTelnyx({ to: TO, body: 'x' }, { env: { TELNYX_API_KEY: 'k' }, fetchImpl: fakeFetch(200, {}, calls) });
  assert.equal(noKey.ok, false);
  assert.equal(noFrom.ok, false);
  assert.equal(calls.length, 0);
});

// ─── Plivo ─────────────────────────────────────────────────────────────────
// POST https://api.plivo.com/v1/Account/{auth_id}/Message/ · Basic · {src,dst,text}

test('plivo: URL carries auth_id, Basic auth, and {src,dst,text} body', async () => {
  const calls: Captured[] = [];
  const res = await sendViaPlivo(
    { to: TO, body: 'Hello from Plivo!' },
    {
      env: { PLIVO_AUTH_ID: 'MAXXXXXXXXXXXXXXXXXX', PLIVO_AUTH_TOKEN: 'tok', PLIVO_FROM: '+14151234567' },
      fetchImpl: fakeFetch(202, { message: 'message(s) queued', message_uuid: ['db3ce55a-7f1d'], api_id: 'a1' }, calls),
    },
  );
  assert.equal(calls[0].url, 'https://api.plivo.com/v1/Account/MAXXXXXXXXXXXXXXXXXX/Message/');
  assert.equal(
    calls[0].init.headers.Authorization,
    `Basic ${Buffer.from('MAXXXXXXXXXXXXXXXXXX:tok').toString('base64')}`,
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    src: '+14151234567',
    dst: TO,
    text: 'Hello from Plivo!',
  });
  // Plivo answers 202 for a queued message — any 2xx must count as success.
  assert.deepEqual(res, { ok: true, provider: 'plivo', providerMessageId: 'db3ce55a-7f1d' });
});

test('plivo: 401 returns ok:false with the vendor message', async () => {
  const calls: Captured[] = [];
  const res = await sendViaPlivo(
    { to: TO, body: 'x' },
    { env: { PLIVO_AUTH_ID: 'a', PLIVO_AUTH_TOKEN: 'bad', PLIVO_FROM: '+1555' }, fetchImpl: fakeFetch(401, { error: 'authentication failed' }, calls) },
  );
  assert.equal(res.ok, false);
  assert.match(String(res.error), /401/);
  assert.match(String(res.error), /authentication failed/);
});

test('plivo: missing credentials short-circuit before any network call', async () => {
  const calls: Captured[] = [];
  const res = await sendViaPlivo({ to: TO, body: 'x' }, { env: { PLIVO_AUTH_ID: 'a' }, fetchImpl: fakeFetch(200, {}, calls) });
  assert.equal(res.ok, false);
  assert.equal(calls.length, 0);
});

// ─── Bandwidth ─────────────────────────────────────────────────────────────
// POST https://messaging.bandwidth.com/api/v2/users/{accountId}/messages
// Basic · { applicationId, to:[...], from, text } · 202 · top-level id

test('bandwidth: URL carries accountId, Basic auth, and `to` is an ARRAY', async () => {
  const calls: Captured[] = [];
  const res = await sendViaBandwidth(
    { to: TO, body: 'Hey, check this out!' },
    {
      env: {
        BANDWIDTH_ACCOUNT_ID: '5000000',
        BANDWIDTH_API_TOKEN: 'tok',
        BANDWIDTH_API_SECRET: 'sec',
        BANDWIDTH_APPLICATION_ID: '93de2206-9669-4e07-948d-329f4b722ee2',
        BANDWIDTH_FROM: '+12345678901',
      },
      fetchImpl: fakeFetch(202, { id: '14762070468292kw2fuqty55yp2b2' }, calls),
    },
  );
  assert.equal(calls[0].url, 'https://messaging.bandwidth.com/api/v2/users/5000000/messages');
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('tok:sec').toString('base64')}`);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.to, [TO], '`to` must be an array per the v2 spec');
  assert.equal(body.from, '+12345678901');
  assert.equal(body.text, 'Hey, check this out!');
  assert.equal(body.applicationId, '93de2206-9669-4e07-948d-329f4b722ee2');
  assert.deepEqual(res, { ok: true, provider: 'bandwidth', providerMessageId: '14762070468292kw2fuqty55yp2b2' });
});

test('bandwidth: every credential is required — a missing applicationId blocks the send', async () => {
  const calls: Captured[] = [];
  const res = await sendViaBandwidth(
    { to: TO, body: 'x' },
    {
      env: {
        BANDWIDTH_ACCOUNT_ID: '5000000',
        BANDWIDTH_API_TOKEN: 'tok',
        BANDWIDTH_API_SECRET: 'sec',
        BANDWIDTH_FROM: '+12345678901',
      },
      fetchImpl: fakeFetch(202, {}, calls),
    },
  );
  assert.equal(res.ok, false);
  assert.match(String(res.error), /BANDWIDTH_APPLICATION_ID/);
  assert.equal(calls.length, 0);
});

test('bandwidth: 400 surfaces description + fieldErrors', async () => {
  const calls: Captured[] = [];
  const res = await sendViaBandwidth(
    { to: TO, body: 'x' },
    {
      env: {
        BANDWIDTH_ACCOUNT_ID: 'a', BANDWIDTH_API_TOKEN: 't', BANDWIDTH_API_SECRET: 's',
        BANDWIDTH_APPLICATION_ID: 'app', BANDWIDTH_FROM: '+1555',
      },
      fetchImpl: fakeFetch(400, { type: 'validation', description: 'bad request', fieldErrors: [{ fieldName: 'from', description: 'not owned' }] }, calls),
    },
  );
  assert.equal(res.ok, false);
  assert.match(String(res.error), /400/);
  assert.match(String(res.error), /bad request/);
  assert.match(String(res.error), /from: not owned/);
});

// ─── Twilio (default) ──────────────────────────────────────────────────────

test('twilio: missing creds warn + return ok:false — same as the pre-transport path', async () => {
  const res = await sendViaTwilio({ to: TO, body: 'x' }, { env: {} });
  assert.equal(res.ok, false);
  assert.equal(res.provider, 'twilio');
  assert.match(String(res.error), /TWILIO_ACCOUNT_SID/);
});

test('twilio: success maps the SDK sid onto providerMessageId', async () => {
  let seen: any = null;
  const res = await sendViaTwilio(
    { to: TO, body: 'hi' },
    {
      env: { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15551112222' },
      clientFactory: () => ({
        messages: {
          create: async (args: any) => { seen = args; return { sid: 'SM123' }; },
        },
      }),
    },
  );
  assert.deepEqual(seen, { body: 'hi', from: '+15551112222', to: TO });
  assert.deepEqual(res, { ok: true, provider: 'twilio', providerMessageId: 'SM123' });
});

test('twilio: a throwing SDK call is contained — ok:false, never rejects', async () => {
  const res = await sendViaTwilio(
    { to: TO, body: 'hi' },
    {
      env: { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15551112222' },
      clientFactory: () => ({
        messages: { create: async () => { throw new Error('21610 unsubscribed recipient'); } },
      }),
    },
  );
  assert.equal(res.ok, false);
  assert.match(String(res.error), /21610/);
});
