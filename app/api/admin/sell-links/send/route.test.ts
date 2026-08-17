// POST/GET /api/admin/sell-links/send — the auth boundary.
//
// This endpoint can put mail in front of ANY address, so admin auth is
// load-bearing rather than ceremonial. Pinned here: an unauthenticated caller
// gets a 401 and nothing downstream runs — no Airtable read, no Resend call,
// no SMS. The delivery logic itself is pinned offline in lib/operatorSend.test.ts.
//
// ADMIN_PASSWORD is set by the npm test script, so the header path is live and
// the "no credential" case is a real refusal rather than an unconfigured one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST, GET } from './route';

const URL_BASE = 'https://www.buyhalfcow.com/api/admin/sell-links/send';

test('an unauthenticated POST is 401 — before any link, buyer or transport is touched', async () => {
  const res = await POST(
    new Request(URL_BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.buyhalfcow.com/shop/recPROD0000000001',
        buyerEmail: 'buyer@example.test',
        email: true,
      }),
    }),
  );
  assert.equal(res.status, 401);
});

test('a WRONG admin password is 401, not a partial success', async () => {
  const res = await POST(
    new Request(URL_BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-password': 'not-the-password' },
      body: JSON.stringify({ url: 'https://www.buyhalfcow.com/shop/recPROD0000000001', buyerEmail: 'b@example.test' }),
    }),
  );
  assert.equal(res.status, 401);
});

test('the capability probe is admin-gated too (it reports channel state)', async () => {
  const res = await GET(new Request(URL_BASE));
  assert.equal(res.status, 401);
});

test('an authenticated probe reports the SMS channel state honestly', async () => {
  const res = await GET(
    new Request(URL_BASE, { headers: { 'x-admin-password': process.env.ADMIN_PASSWORD || '' } }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  // ENABLE_SMS is unset in the test env, exactly as it is in production —
  // the console must be told the channel is dark before it renders the button.
  assert.equal(body.smsEnabled, false);
});

test('an authenticated send REFUSES a raw Stripe checkout URL', async () => {
  const res = await POST(
    new Request(URL_BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-password': process.env.ADMIN_PASSWORD || '' },
      body: JSON.stringify({
        url: 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3',
        buyerEmail: 'buyer@example.test',
      }),
    }),
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(String(body.error), /stripe/i);
});

test('an authenticated send with no channel picked is refused before any work', async () => {
  const res = await POST(
    new Request(URL_BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-password': process.env.ADMIN_PASSWORD || '' },
      body: JSON.stringify({
        url: 'https://www.buyhalfcow.com/shop/recPROD0000000001',
        buyerEmail: 'buyer@example.test',
        email: false,
        sms: false,
      }),
    }),
  );
  assert.equal(res.status, 400);
});
