// POST /api/checkout/broker-reserve — the tokenless self-serve sibling of
// /r/b/<token>.
//
// The Airtable + brokerReferral layers are injected (BrokerReserveDeps) — the
// repo's node:test setup has no module mocking, so the route exports its core
// as handleBrokerReserve(body, deps) and the POST wrapper wires the real
// modules. Pinned here:
//   1. input validation refuses before ANY dep is touched (bad email → 400);
//   2. every rail gate fails closed with its 4xx (non-broker, flag off,
//      unsellable cut, unknown slug);
//   3. the happy path calls findOrCreateBrokerReferral exactly ONCE, sets the
//      referral-scoped deposit-grant cookie, and returns the SAME path the
//      /r/b redemption 302s to — never a raw Stripe URL;
//   4. a re-tap with an existing consumer creates NO second consumer and
//      relies on findOrCreateBrokerReferral's reuse (no duplicate creation).
//
// Synthetic ranch names + example.com buyers throughout — the repo is PUBLIC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBrokerReserveInput,
  handleBrokerReserve,
  type BrokerReserveDeps,
} from './route';
import { DEPOSIT_GRANT_COOKIE } from '@/lib/campaignReserve';

function selfServeRancher(over: Record<string, any> = {}) {
  return {
    id: 'recBROKERSELF01',
    'Ranch Name': 'Granite Hollow Beef',
    State: 'AZ',
    'Broker Rail': true,
    'Broker Self Serve': true,
    'Half Price': 1800,
    'Half Deposit': 200,
    ...over,
  };
}

function goodBody(over: Record<string, any> = {}) {
  return {
    slug: 'granite-hollow-beef',
    cut: 'half',
    email: 'Buyer@Example.com',
    name: 'Test Buyer',
    phone: '(555) 123-4567',
    ...over,
  };
}

interface Calls {
  fetch: number;
  getConsumer: number;
  createConsumer: number;
  patchConsumer: number;
  referral: number;
  referralArgs: any[];
  consumerFields: any[];
}

function fakeDeps(
  over: Partial<BrokerReserveDeps> & { rancher?: any } = {},
): { deps: BrokerReserveDeps; calls: Calls } {
  const calls: Calls = {
    fetch: 0,
    getConsumer: 0,
    createConsumer: 0,
    patchConsumer: 0,
    referral: 0,
    referralArgs: [],
    consumerFields: [],
  };
  const rancher = 'rancher' in over ? over.rancher : selfServeRancher();
  const { rancher: _drop, ...depOverrides } = over;
  const deps: BrokerReserveDeps = {
    fetchRancherBySlug: async () => {
      calls.fetch += 1;
      return rancher;
    },
    getConsumerByEmail: async () => {
      calls.getConsumer += 1;
      return null;
    },
    createConsumer: async (fields) => {
      calls.createConsumer += 1;
      calls.consumerFields.push(fields);
      return { id: 'recCONSUMER0001' };
    },
    patchConsumer: async () => {
      calls.patchConsumer += 1;
    },
    findOrCreateBrokerReferral: async (args) => {
      calls.referral += 1;
      calls.referralArgs.push(args);
      return { ok: true, referralId: 'recREFERRAL0001', created: true, rancher };
    },
    mintDepositGrantToken: () => 'grant-token-test',
    ...depOverrides,
  };
  return { deps, calls };
}

// ── validateBrokerReserveInput ───────────────────────────────────────────

test('input: bad email → 400; throwaway domain → 400', () => {
  const bad = validateBrokerReserveInput(goodBody({ email: 'not-an-email' }));
  assert.ok(!bad.ok && bad.status === 400);
  const throwaway = validateBrokerReserveInput(goodBody({ email: 'x@mailinator.com' }));
  assert.ok(!throwaway.ok && throwaway.status === 400);
});

test('input: bad cut / missing slug → 400', () => {
  const cut = validateBrokerReserveInput(goodBody({ cut: 'sirloin' }));
  assert.ok(!cut.ok && cut.status === 400);
  const slug = validateBrokerReserveInput(goodBody({ slug: '' }));
  assert.ok(!slug.ok && slug.status === 400);
});

test('input: phone optional, but a supplied-yet-garbled phone → 400', () => {
  const none = validateBrokerReserveInput(goodBody({ phone: '' }));
  assert.ok(none.ok && none.input.phone === '');
  const garbled = validateBrokerReserveInput(goodBody({ phone: '12' }));
  assert.ok(!garbled.ok && garbled.status === 400);
  const good = validateBrokerReserveInput(goodBody());
  assert.ok(good.ok);
  if (good.ok) {
    assert.equal(good.input.phone, '+15551234567'); // normalizeReservePhone E.164
    assert.equal(good.input.email, 'buyer@example.com'); // lowercased
    assert.equal(good.input.cut, 'half');
  }
});

// ── handleBrokerReserve gates ────────────────────────────────────────────

test('bad input refuses BEFORE any dep is touched', async () => {
  const { deps, calls } = fakeDeps();
  const res = await handleBrokerReserve(goodBody({ email: 'nope' }), deps);
  assert.equal(res.status, 400);
  assert.equal(calls.fetch, 0);
  assert.equal(calls.referral, 0);
});

test('unknown slug → 404, nothing created', async () => {
  const { deps, calls } = fakeDeps({ rancher: null });
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 404);
  assert.equal(calls.createConsumer, 0);
  assert.equal(calls.referral, 0);
});

test('non-broker rancher → 409, nothing created', async () => {
  const { deps, calls } = fakeDeps({ rancher: selfServeRancher({ 'Broker Rail': undefined }) });
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 409);
  const j: any = await res.json();
  assert.equal(j.error, 'not_broker_rail');
  assert.equal(calls.createConsumer, 0);
  assert.equal(calls.referral, 0);
});

test('broker rancher with the flag OFF → 409 (stays token-only)', async () => {
  const { deps, calls } = fakeDeps({
    rancher: selfServeRancher({ 'Broker Self Serve': undefined }),
  });
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 409);
  const j: any = await res.json();
  assert.equal(j.error, 'self_serve_unavailable');
  assert.equal(calls.createConsumer, 0);
  assert.equal(calls.referral, 0);
});

test('unsellable cut (no deposit set) → 409, nothing created', async () => {
  const { deps, calls } = fakeDeps({ rancher: selfServeRancher({ 'Half Deposit': undefined }) });
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 409);
  const j: any = await res.json();
  assert.equal(j.error, 'no_deposit');
  assert.equal(calls.referral, 0);
});

// ── happy path ───────────────────────────────────────────────────────────

test('happy path: one referral resolve, grant cookie, /r/b-shaped redirect', async () => {
  const { deps, calls } = fakeDeps();
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 200);

  const j: any = await res.json();
  // The SAME path the /r/b route 302s to (brokerDepositPathFor) — a page on
  // OUR origin, never a raw Stripe URL.
  assert.deepEqual(j, { redirect: '/checkout/recREFERRAL0001/broker?cut=half' });
  assert.ok(!JSON.stringify(j).includes('stripe'), 'no Stripe URL may ride this response');

  // Referral-scoped deposit grant rides the response, exactly as /r/b sets it.
  assert.equal(res.cookies.get(DEPOSIT_GRANT_COOKIE)?.value, 'grant-token-test');

  // findOrCreateBrokerReferral ran exactly once, addressed by record id.
  assert.equal(calls.referral, 1);
  assert.deepEqual(calls.referralArgs[0], {
    consumerId: 'recCONSUMER0001',
    rancherId: 'recBROKERSELF01',
    cut: 'half',
  });

  // The consumer was created the way the token (sell-links) path would:
  // submitted email/name, the RANCH's state, and the buyer's phone.
  assert.equal(calls.createConsumer, 1);
  assert.equal(calls.consumerFields[0]['Email'], 'buyer@example.com');
  assert.equal(calls.consumerFields[0]['Full Name'], 'Test Buyer');
  assert.equal(calls.consumerFields[0]['State'], 'AZ');
  assert.equal(calls.consumerFields[0]['Phone'], '+15551234567');
});

test('re-tap with an existing consumer: NO second consumer, referral reused', async () => {
  const existing = { id: 'recCONSUMER0001', Email: 'buyer@example.com', Phone: '+15551234567' };
  const { deps, calls } = fakeDeps({
    getConsumerByEmail: async () => existing,
    findOrCreateBrokerReferral: async (args) => {
      calls.referral += 1;
      calls.referralArgs.push(args);
      // Second tap: lib/brokerReferral finds the open broker referral and
      // reuses it (created:false) — no duplicate row.
      return { ok: true, referralId: 'recREFERRAL0001', created: false, rancher: selfServeRancher() };
    },
  });
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 200);
  const j: any = await res.json();
  assert.equal(j.redirect, '/checkout/recREFERRAL0001/broker?cut=half');
  assert.equal(calls.createConsumer, 0, 'must not create a duplicate consumer');
  assert.equal(calls.referral, 1, 'find-or-create runs once per POST');
  // Phone already on record → no backfill write either.
  assert.equal(calls.patchConsumer, 0);
});

test('existing consumer with a BLANK phone gets a blank-only backfill', async () => {
  const patches: any[] = [];
  const { deps } = fakeDeps({
    getConsumerByEmail: async () => ({ id: 'recCONSUMER0001', Email: 'buyer@example.com' }),
    patchConsumer: async (_id, patch) => {
      patches.push(patch);
    },
  });
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(patches, [{ Phone: '+15551234567' }]);
});

test('referral io-error → 502 buyer-safe retry, no half-created state exposed', async () => {
  const { deps } = fakeDeps({
    findOrCreateBrokerReferral: async () => ({ ok: false, reason: 'io-error' }),
  });
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 502);
  const j: any = await res.json();
  assert.ok(typeof j.error === 'string' && j.error.length > 0);
});

test('rail flipped between render and POST (referral says not-broker-rail) → 409', async () => {
  const { deps } = fakeDeps({
    findOrCreateBrokerReferral: async () => ({ ok: false, reason: 'not-broker-rail' }),
  });
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 409);
});

test('grant-mint failure still returns the redirect (mirrors /r/b), sans cookie', async () => {
  const { deps } = fakeDeps({
    mintDepositGrantToken: () => {
      throw new Error('secret unavailable');
    },
  });
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 200);
  const j: any = await res.json();
  assert.equal(j.redirect, '/checkout/recREFERRAL0001/broker?cut=half');
  assert.equal(res.cookies.get(DEPOSIT_GRANT_COOKIE), undefined);
});
