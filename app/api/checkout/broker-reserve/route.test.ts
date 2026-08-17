// POST /api/checkout/broker-reserve — the tokenless self-serve sibling of
// /r/b/<token>.
//
// The auth + Airtable + brokerReferral + email layers are injected
// (BrokerReserveDeps) — the repo's node:test setup has no module mocking, so
// the route exports its core as handleBrokerReserve(body, deps) and the POST
// wrapper wires the real modules. Pinned here:
//   1. input validation refuses before ANY dep is touched (bad email → 400);
//   2. every rail gate fails closed with its 4xx (non-broker, flag off,
//      unsellable cut, unknown slug);
//   3. ACCOUNT-TAKEOVER GUARD (the security fix): WHO gets the deposit grant —
//        • freshly-created consumer → grant + redirect;
//        • authenticated member session → grant + redirect (no email lookup);
//        • adopted pre-existing consumer with NO session → NO grant, NO write
//          to that consumer, a magic link is emailed, and the response is
//          { requiresEmailVerification } (never a referral-credentialing of
//          the anonymous caller);
//   4. the happy path returns the SAME path /r/b 302s to — never a Stripe URL;
//   5. a re-tap never duplicates the consumer (find-or-create reuse);
//   6. a magic-link SEND FAILURE voids the phantom Pending hold (→ Lost),
//      mirroring the reserve route, and a void blip never masks the 502;
//   7. an empty-consumerId session is NOT treated as authenticated (the
//      `!existingSession?.consumerId` guard tightening — defense in depth).
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
  session: number;
  fetch: number;
  getConsumer: number;
  createConsumer: number;
  referral: number;
  verifyLink: number;
  voidReferral: number;
  referralArgs: any[];
  consumerFields: any[];
  verifyArgs: any[];
  voidArgs: any[];
}

function fakeDeps(
  over: Partial<BrokerReserveDeps> & { rancher?: any } = {},
): { deps: BrokerReserveDeps; calls: Calls } {
  const calls: Calls = {
    session: 0,
    fetch: 0,
    getConsumer: 0,
    createConsumer: 0,
    referral: 0,
    verifyLink: 0,
    voidReferral: 0,
    referralArgs: [],
    consumerFields: [],
    verifyArgs: [],
    voidArgs: [],
  };
  const rancher = 'rancher' in over ? over.rancher : selfServeRancher();
  const { rancher: _drop, ...depOverrides } = over;
  const deps: BrokerReserveDeps = {
    getExistingSession: async () => {
      calls.session += 1;
      return null; // anonymous by default
    },
    fetchRancherBySlug: async () => {
      calls.fetch += 1;
      return rancher;
    },
    getConsumerByEmail: async () => {
      calls.getConsumer += 1;
      return null; // new email by default
    },
    createConsumer: async (fields) => {
      calls.createConsumer += 1;
      calls.consumerFields.push(fields);
      return { id: 'recCONSUMER0001' };
    },
    findOrCreateBrokerReferral: async (args) => {
      calls.referral += 1;
      calls.referralArgs.push(args);
      return { ok: true, referralId: 'recREFERRAL0001', created: true, rancher };
    },
    mintDepositGrantToken: () => 'grant-token-test',
    sendVerificationLink: async (args) => {
      calls.verifyLink += 1;
      calls.verifyArgs.push(args);
      return true; // email sent by default
    },
    voidReferral: async (referralId, note) => {
      calls.voidReferral += 1;
      calls.voidArgs.push({ referralId, note });
    },
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

// ── happy path: freshly-created consumer (anonymous, new email) ────────────

test('new email + no session → create consumer, one referral, grant cookie, /r/b-shaped redirect', async () => {
  const { deps, calls } = fakeDeps();
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 200);

  const j: any = await res.json();
  // The SAME path the /r/b route 302s to (brokerDepositPathFor) — a page on
  // OUR origin, never a raw Stripe URL.
  assert.deepEqual(j, { redirect: '/checkout/recREFERRAL0001/broker?cut=half' });
  assert.ok(!JSON.stringify(j).includes('stripe'), 'no Stripe URL may ride this response');

  // A freshly-created consumer is safe to credential — deposit grant rides
  // the response, exactly as /r/b sets it. No magic link.
  assert.equal(res.cookies.get(DEPOSIT_GRANT_COOKIE)?.value, 'grant-token-test');
  assert.equal(calls.verifyLink, 0);

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

// ── ACCOUNT-TAKEOVER GUARD ─────────────────────────────────────────────────

test('adopted existing email + NO session → magic link, NO grant, NO consumer write', async () => {
  const existing = { id: 'recVICTIM0001', Email: 'buyer@example.com' };
  const { deps, calls } = fakeDeps({
    getConsumerByEmail: async () => {
      calls.getConsumer += 1;
      return existing;
    },
  });
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 200);

  const j: any = await res.json();
  // The anonymous caller is NOT credentialed: no grant cookie, no redirect
  // that would unlock the victim's referral — only a verification prompt.
  assert.equal(res.cookies.get(DEPOSIT_GRANT_COOKIE), undefined);
  assert.equal(j.requiresEmailVerification, true);
  assert.ok(typeof j.message === 'string' && j.message.length > 0);
  assert.ok(!('redirect' in j), 'must NOT hand back a checkout redirect for an unverified adopt');

  // A magic link was emailed to the OWNER, pointing at the broker deposit path.
  assert.equal(calls.verifyLink, 1);
  assert.equal(calls.verifyArgs[0].consumerId, 'recVICTIM0001');
  assert.equal(calls.verifyArgs[0].email, 'buyer@example.com');
  assert.equal(calls.verifyArgs[0].depositPath, '/checkout/recREFERRAL0001/broker?cut=half');

  // The victim's consumer is never written to (no phone overwrite, no create).
  assert.equal(calls.createConsumer, 0);
});

test('adopted existing email, magic-link send FAILS → 502, no grant, honest retry, phantom hold voided', async () => {
  const { deps, calls } = fakeDeps({
    getConsumerByEmail: async () => ({ id: 'recVICTIM0001', Email: 'buyer@example.com' }),
    sendVerificationLink: async () => false,
  });
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 502);
  const j: any = await res.json();
  assert.equal(res.cookies.get(DEPOSIT_GRANT_COOKIE), undefined);
  assert.ok(!('requiresEmailVerification' in j), 'never claim a link was sent when it was not');

  // The phantom Pending broker referral is voided (→ Lost), mirroring the
  // reserve route — a failed send never strands a hold the rancher sees.
  assert.equal(calls.voidReferral, 1);
  assert.equal(calls.voidArgs[0].referralId, 'recREFERRAL0001');
  assert.ok(/lost|void/i.test(calls.voidArgs[0].note), 'void note explains the auto-void');
});

test('adopted-existing send-fail: a void blip must NOT mask the buyer-facing 502', async () => {
  const { deps, calls } = fakeDeps({
    getConsumerByEmail: async () => ({ id: 'recVICTIM0001', Email: 'buyer@example.com' }),
    sendVerificationLink: async () => false,
    voidReferral: async () => {
      throw new Error('airtable blip');
    },
  });
  const res = await handleBrokerReserve(goodBody(), deps);
  // Void failure is swallowed — the buyer still gets the honest 502 retry.
  assert.equal(res.status, 502);
  assert.equal(calls.voidReferral, 0, 'the throwing fake never increments (it threw)');
  const j: any = await res.json();
  assert.ok(!('requiresEmailVerification' in j));
});

test('happy path (new consumer) never voids the referral', async () => {
  const { deps, calls } = fakeDeps();
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 200);
  assert.equal(calls.voidReferral, 0, 'a successful reserve must not void its own hold');
});

// ── ACCOUNT-TAKEOVER GUARD: empty-consumerId session edge (defense in depth) ──

test('session decoded to an EMPTY consumerId + adopted email → magic link, NO grant (guard tightening)', async () => {
  // A member-session JWT that carried an empty consumerId still resolves to a
  // NON-null session object. The old `!existingSession` guard would treat that
  // as "authenticated" and credential the adopted (unverified) consumer.
  // `!existingSession?.consumerId` keeps it on the verification path.
  const { deps, calls } = fakeDeps({
    getExistingSession: async () => ({ consumerId: '' }),
    getConsumerByEmail: async () => ({ id: 'recVICTIM0001', Email: 'buyer@example.com' }),
  });
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 200);
  const j: any = await res.json();
  assert.equal(res.cookies.get(DEPOSIT_GRANT_COOKIE), undefined, 'no grant on an empty-consumerId session');
  assert.equal(j.requiresEmailVerification, true);
  assert.ok(!('redirect' in j), 'must not hand back a checkout redirect');
  assert.equal(calls.verifyLink, 1, 'ownership must be proven via the magic link');
  assert.equal(calls.verifyArgs[0].consumerId, 'recVICTIM0001');
});

test('authenticated session → grant minted directly, no email lookup, no magic link', async () => {
  const { deps, calls } = fakeDeps({
    getExistingSession: async () => ({ consumerId: 'recSESSION0001' }),
  });
  const res = await handleBrokerReserve(goodBody(), deps);
  assert.equal(res.status, 200);

  const j: any = await res.json();
  assert.equal(j.redirect, '/checkout/recREFERRAL0001/broker?cut=half');
  // A logged-in buyer is authenticated → credentialed with the grant.
  assert.equal(res.cookies.get(DEPOSIT_GRANT_COOKIE)?.value, 'grant-token-test');
  // Session identity is used directly — no email lookup, no create, no email.
  assert.equal(calls.getConsumer, 0);
  assert.equal(calls.createConsumer, 0);
  assert.equal(calls.verifyLink, 0);
  assert.equal(calls.referralArgs[0].consumerId, 'recSESSION0001');
});

// ── reuse + failure semantics ──────────────────────────────────────────────

test('re-tap: find-or-create runs once per POST (reuse handled inside it)', async () => {
  const { deps, calls } = fakeDeps({
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
  assert.equal(calls.referral, 1, 'find-or-create runs once per POST');
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

test('grant-mint failure (new-consumer path, no session) → 500 inline, no false sent-link', async () => {
  const { deps } = fakeDeps({
    mintDepositGrantToken: () => {
      throw new Error('secret unavailable');
    },
  });
  const res = await handleBrokerReserve(goodBody(), deps);
  // No session + no grant → redirecting would show the shared checkout page's
  // "the link we sent you" copy, which is false here. Honest inline retry.
  assert.equal(res.status, 500);
  const j: any = await res.json();
  assert.equal(res.cookies.get(DEPOSIT_GRANT_COOKIE), undefined);
  assert.ok(!('redirect' in j), 'must not dead-end on the false sent-link checkout copy');
  assert.ok(typeof j.error === 'string' && !/link/i.test(j.error), 'copy must not claim a sent link');
});

test('grant-mint failure WITH a session → redirect (member session authorizes)', async () => {
  const { deps } = fakeDeps({
    getExistingSession: async () => ({ consumerId: 'recSESSION0001' }),
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
