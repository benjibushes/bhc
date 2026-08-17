// lib/operatorSend — the operator "send it" rail.
//
// THE INVARIANT UNDER TEST, above every other: the console may never report a
// send that did not happen. A suppressed recipient, a dead transport, and a
// platform-disabled channel are three DIFFERENT non-successes, each of which
// must name itself and its reason — because the operator is on the phone with
// the buyer and can still read the link out loud if he is told the truth.
//
// Everything here runs offline: the transports, the idempotency claim and the
// Airtable stamp are injected, so these pins never touch Resend, an SMS vendor
// or Airtable.
//
// Synthetic ids, ranch names and addresses throughout — the repo is PUBLIC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSendTarget,
  buildSendCopy,
  classifyEmailResult,
  isRetryableFailure,
  resolveSmsGate,
  sendClaimKey,
  summarizeSend,
  deliverOperatorSend,
  type ChannelOutcome,
  type DeliverDeps,
  type SendTarget,
} from './operatorSend';
import { mintCampaignReserveToken, mintBrokerReserveToken } from './campaignReserve';

const SITE = 'https://www.buyhalfcow.com';
const BUYER_ID = 'recBUYER00000001';
const PRODUCT_ID = 'recPROD0000000001';

// ---------------------------------------------------------------------------
// resolveSendTarget — what this endpoint is allowed to mail
// ---------------------------------------------------------------------------

test('a CONNECT /r/d link is accepted and yields the buyer id from the token', () => {
  const url = `${SITE}/r/d/${mintCampaignReserveToken({ consumerId: BUYER_ID, rancherSlug: 'cedar-draw', cut: 'half' })}`;
  const out = resolveSendTarget(url, SITE);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.target.rail, 'connect');
  assert.equal(out.target.consumerId, BUYER_ID);
  assert.equal(out.target.cut, 'half');
});

test('a BROKER /r/b link is accepted on its own rail', () => {
  const url = `${SITE}/r/b/${mintBrokerReserveToken({ consumerId: BUYER_ID, rancherId: 'recBROKERRANCH01', cut: 'quarter' })}`;
  const out = resolveSendTarget(url, SITE);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.target.rail, 'broker');
  assert.equal(out.target.consumerId, BUYER_ID);
});

test('a durable /shop/<recordId> product link is accepted', () => {
  const out = resolveSendTarget(`${SITE}/shop/${PRODUCT_ID}`, SITE);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.target.rail, 'product');
  assert.equal(out.target.consumerId, ''); // no token, resolved by the route
});

test('a raw Stripe checkout URL is REFUSED — it expires in ~24h', () => {
  const out = resolveSendTarget('https://checkout.stripe.com/c/pay/cs_test_a1b2c3', SITE);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.error, /stripe/i);
});

test('an off-host link is refused even when its path looks right', () => {
  const out = resolveSendTarget('https://evil.example/r/d/whatever', SITE);
  assert.equal(out.ok, false);
});

test('a tampered or expired reserve token is refused rather than mailed', () => {
  const good = mintCampaignReserveToken({ consumerId: BUYER_ID, rancherSlug: 'cedar-draw', cut: 'half' });
  const out = resolveSendTarget(`${SITE}/r/d/${good.slice(0, -3)}xyz`, SITE);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.error, /mint a fresh one/);
});

test('a broker token pasted on the connect path cannot be sent (rails never cross)', () => {
  const brokerToken = mintBrokerReserveToken({ consumerId: BUYER_ID, rancherId: 'recBROKERRANCH01', cut: 'half' });
  assert.equal(resolveSendTarget(`${SITE}/r/d/${brokerToken}`, SITE).ok, false);
});

test('an arbitrary on-site page is refused (this is not a generic mailer)', () => {
  for (const path of ['/', '/admin', '/shop', '/shop/not-a-record-id', '/r/d/']) {
    assert.equal(resolveSendTarget(`${SITE}${path}`, SITE).ok, false, path);
  }
});

// ---------------------------------------------------------------------------
// Copy — per rail, in Ben's voice, with the broker money truth withheld
// ---------------------------------------------------------------------------

const COMMISSION_WORDS = /commission|fee|our cut|we keep|markup|middleman|broker/i;

test('BROKER buyer copy never reveals that the deposit is the commission', () => {
  const copy = buildSendCopy({
    rail: 'broker',
    url: `${SITE}/r/b/token`,
    firstName: 'Dana',
    itemLabel: 'Half Cow',
    sellerName: 'Cedar Draw Beef',
    amount: 400,
    total: 1800,
  });
  for (const surface of [copy.subject, copy.html, copy.text, copy.sms]) {
    assert.doesNotMatch(surface, COMMISSION_WORDS, `commission language leaked: ${surface}`);
  }
  // What it DOES say: a deposit toward the share, balance to the ranch.
  assert.match(copy.text, /deposit toward your share/i);
  assert.match(copy.text, /balance directly with the ranch/i);
});

test('BROKER weight-priced copy quotes an estimated RANGE, never an exact total', () => {
  const copy = buildSendCopy({
    rail: 'broker',
    url: `${SITE}/r/b/token`,
    itemLabel: 'Half Cow',
    amount: 400,
    total: 1800,
    totalMax: 2400,
  });
  assert.match(copy.text, /estimated \$1,800–\$2,400/);
  assert.match(copy.text, /hanging weight/);
  assert.doesNotMatch(copy.sms, COMMISSION_WORDS);
});

test('CONNECT copy is the refundable-hold promise, PRODUCT copy is a checkout', () => {
  const connect = buildSendCopy({
    rail: 'connect',
    url: `${SITE}/r/d/token`,
    itemLabel: 'Half Cow',
    sellerName: 'Cedar Draw Beef',
    amount: 600,
  });
  assert.match(connect.text, /refundable/i);

  const product = buildSendCopy({
    rail: 'product',
    url: `${SITE}/shop/${PRODUCT_ID}`,
    itemLabel: 'Sampler Box',
    sellerName: 'Cedar Draw Beef',
    amount: 170,
  });
  assert.match(product.text, /\$170/);
  assert.doesNotMatch(product.text, /refundable/i);
  assert.doesNotMatch(product.text, /deposit/i);
});

test('every rail signs "— Ben", keeps the subject lowercase, and carries the link', () => {
  for (const rail of ['connect', 'broker', 'product'] as const) {
    const copy = buildSendCopy({ rail, url: `${SITE}/r/d/tok`, itemLabel: 'Half Cow', amount: 600 });
    assert.equal(copy.subject, copy.subject.toLowerCase(), rail);
    assert.ok(copy.subject.split(/\s+/).length <= 4, `${rail} subject too long: ${copy.subject}`);
    assert.match(copy.text, /— Ben$/);
    assert.ok(copy.text.includes(`${SITE}/r/d/tok`), rail);
    assert.ok(copy.html.includes(`${SITE}/r/d/tok`), rail);
    assert.ok(copy.sms.includes(`${SITE}/r/d/tok`), rail);
  }
});

test('a missing amount never prints a bare "$" or a NaN at the buyer', () => {
  for (const rail of ['connect', 'broker', 'product'] as const) {
    const copy = buildSendCopy({ rail, url: `${SITE}/shop/${PRODUCT_ID}`, itemLabel: 'Half Cow' });
    for (const s of [copy.text, copy.sms, copy.html]) {
      assert.doesNotMatch(s, /NaN|\$undefined|\$ /, `${rail}: ${s}`);
    }
  }
});

// ---------------------------------------------------------------------------
// classifyEmailResult — the suppressed-is-not-success rule
// ---------------------------------------------------------------------------

test('guardedSend {success:true} is the ONLY delivered outcome', () => {
  assert.equal(classifyEmailResult({ success: true }).state, 'delivered');
});

test('a suppressed recipient reports NOT delivered, with the reason', () => {
  const o = classifyEmailResult({ success: false, suppressed: true, reason: 'unsubscribed-bounced-or-complained' });
  assert.equal(o.state, 'suppressed');
  assert.match(o.reason, /unsubscribed/);
});

test('a cap-exceeded suppression is also NOT a send', () => {
  const o = classifyEmailResult({ success: false, suppressed: true, reason: 'cap-exceeded' });
  assert.equal(o.state, 'suppressed');
  assert.notEqual(o.state as string, 'delivered');
});

test('a resolved transport error is a failure carrying what the mailer said', () => {
  const o = classifyEmailResult({ success: false, reason: 'validation_error: API key is invalid' });
  assert.equal(o.state, 'failed');
  assert.match(o.reason, /API key/);
});

test('a missing result is a failure, never an assumed success', () => {
  assert.equal(classifyEmailResult(null).state, 'failed');
  assert.equal(classifyEmailResult(undefined).state, 'failed');
});

// ---------------------------------------------------------------------------
// isRetryableFailure — retry the wire, never the suppression
// ---------------------------------------------------------------------------

test('wire-shaped failures are retryable', () => {
  for (const reason of ['fetch failed', 'ETIMEDOUT', 'socket hang up', '503 service unavailable', 'ECONNRESET']) {
    assert.equal(isRetryableFailure({ state: 'failed', reason }), true, reason);
  }
});

test('suppressions and hard bounces are TERMINAL — never retried', () => {
  assert.equal(isRetryableFailure({ state: 'suppressed', reason: 'unsubscribed' }), false);
  for (const reason of [
    'recipient has hard bounced',
    'address is suppressed',
    'invalid recipient address',
    'unauthorized: bad api key',
    'validation_error',
    // even when a terminal word rides alongside a retryable one
    'network error: recipient bounced permanently',
  ]) {
    assert.equal(isRetryableFailure({ state: 'failed', reason }), false, reason);
  }
});

// ---------------------------------------------------------------------------
// resolveSmsGate — the channel must say it is off BEFORE anyone taps
// ---------------------------------------------------------------------------

const OPTED_IN = { id: BUYER_ID, 'SMS Opt-In': true, Phone: '+15555550123' };

test('ENABLE_SMS off reports channel-disabled — never a silent no-op', () => {
  const g = resolveSmsGate({ enabled: false, consumer: OPTED_IN });
  assert.equal(g.ok, false);
  if (g.ok) return;
  assert.equal(g.outcome.state, 'channel-disabled');
  assert.match(g.outcome.reason, /ENABLE_SMS/);
});

test('no TCPA opt-in is no-consent, and an unsubscribed buyer is too', () => {
  const noOptIn = resolveSmsGate({ enabled: true, consumer: { id: BUYER_ID, Phone: '+15555550123' } });
  assert.equal(noOptIn.ok, false);
  if (!noOptIn.ok) assert.equal(noOptIn.outcome.state, 'no-consent');

  const unsub = resolveSmsGate({ enabled: true, consumer: { ...OPTED_IN, Unsubscribed: true } });
  assert.equal(unsub.ok, false);
  if (!unsub.ok) assert.equal(unsub.outcome.state, 'no-consent');
});

test('an opted-in buyer with no number reports no-destination, not a send', () => {
  const g = resolveSmsGate({ enabled: true, consumer: { id: BUYER_ID, 'SMS Opt-In': true } });
  assert.equal(g.ok, false);
  if (!g.ok) assert.equal(g.outcome.state, 'no-destination');
});

test('an operator-supplied number overrides the record', () => {
  const g = resolveSmsGate({ enabled: true, consumer: OPTED_IN, phone: '+15555559999' });
  assert.equal(g.ok, true);
  if (g.ok) assert.equal(g.to, '+15555559999');
});

// ---------------------------------------------------------------------------
// summarizeSend — "nobody heard anything" must be loud
// ---------------------------------------------------------------------------

test('both channels failing is LOUD; one delivery is not', () => {
  const failed: ChannelOutcome = { state: 'failed', reason: 'x' };
  const disabled: ChannelOutcome = { state: 'channel-disabled', reason: 'off' };
  const ok: ChannelOutcome = { state: 'delivered', reason: '' };

  assert.deepEqual(summarizeSend([failed, disabled]), { reached: false, loud: true });
  assert.deepEqual(summarizeSend([ok, disabled]), { reached: true, loud: false });
  assert.deepEqual(summarizeSend([failed, ok]), { reached: true, loud: false });
  // Nothing attempted is not a failure to shout about.
  assert.deepEqual(summarizeSend([{ state: 'not-requested', reason: '' }]), { reached: false, loud: false });
});

// ---------------------------------------------------------------------------
// deliverOperatorSend — the whole rail, offline
// ---------------------------------------------------------------------------

const TARGET: SendTarget = {
  rail: 'connect',
  consumerId: BUYER_ID,
  cut: 'half',
  url: `${SITE}/r/d/tok`,
};

const COPY = buildSendCopy({ rail: 'connect', url: TARGET.url, itemLabel: 'Half Cow', amount: 600 });

interface Spy {
  emails: { to: string }[];
  texts: { to: string }[];
  stamps: { consumerId: string; at: string }[];
  claimed: Set<string>;
  deps: DeliverDeps;
}

/**
 * A fake world. `email` / `sms` decide what each transport does; `claims`
 * is REAL once-only semantics (first caller wins) so a double-tap is exercised
 * the way Redis would behave, not simulated.
 */
function spy(opts: {
  email?: () => Promise<any>;
  sms?: () => Promise<boolean>;
  stampThrows?: boolean;
} = {}): Spy {
  const s: Spy = {
    emails: [],
    texts: [],
    stamps: [],
    claimed: new Set<string>(),
    deps: null as any,
  };
  s.deps = {
    sendEmail: async ({ to }) => {
      s.emails.push({ to });
      return opts.email ? await opts.email() : { success: true };
    },
    sendSms: async ({ to }) => {
      s.texts.push({ to });
      return opts.sms ? await opts.sms() : true;
    },
    claim: async (key) => {
      if (s.claimed.has(key)) return false;
      s.claimed.add(key);
      return true;
    },
    stamp: async (args) => {
      if (opts.stampThrows) throw new Error('airtable 429');
      s.stamps.push(args);
    },
  };
  return s;
}

function baseInput(over: Record<string, any> = {}) {
  return {
    target: TARGET,
    copy: COPY,
    email: 'buyer@example.test',
    wantEmail: true,
    wantSms: false,
    sms: { enabled: false, consumer: OPTED_IN },
    ...over,
  } as any;
}

test('happy path: email delivered, stamp written, exactly one send', async () => {
  const s = spy();
  const out = await deliverOperatorSend(baseInput(), s.deps);

  assert.equal(out.email.state, 'delivered');
  assert.equal(out.reached, true);
  assert.equal(out.loud, false);
  assert.equal(s.emails.length, 1);
  assert.equal(out.stamped, true);
  assert.equal(s.stamps.length, 1);
  assert.equal(s.stamps[0].consumerId, BUYER_ID);
});

test('suppressed recipient: reported NOT delivered, with the reason, and NO stamp', async () => {
  const s = spy({ email: async () => ({ success: false, suppressed: true, reason: 'unsubscribed-bounced-or-complained' }) });
  const out = await deliverOperatorSend(baseInput(), s.deps);

  assert.equal(out.email.state, 'suppressed');
  assert.match(out.email.reason, /unsubscribed/);
  assert.equal(out.reached, false);
  assert.equal(out.loud, true);
  // A false success stamp would tell every marketing rail to back off from a
  // buyer who was never actually contacted.
  assert.equal(out.stamped, false);
  assert.equal(s.stamps.length, 0);
});

test('a thrown transport surfaces as failed and never escapes the call', async () => {
  const s = spy({ email: async () => { throw new Error('getaddrinfo ENOTFOUND api.resend.com'); } });
  const out = await deliverOperatorSend(baseInput(), s.deps);

  assert.equal(out.email.state, 'failed');
  assert.match(out.email.reason, /ENOTFOUND/);
  assert.equal(out.loud, true);
  assert.equal(out.stamped, false);
  // The target (and therefore the link the console shows for manual fallback)
  // is untouched by the failure.
  assert.equal(TARGET.url, `${SITE}/r/d/tok`);
});

test('a wire failure is retried ONCE and reports the retry when it succeeds', async () => {
  let n = 0;
  const s = spy({
    email: async () => {
      n += 1;
      return n === 1 ? { success: false, reason: 'fetch failed' } : { success: true };
    },
  });
  const out = await deliverOperatorSend(baseInput(), s.deps);
  assert.equal(out.email.state, 'delivered');
  assert.equal(n, 2, 'exactly one retry, never a loop');
});

test('a suppression is NEVER retried', async () => {
  let n = 0;
  const s = spy({
    email: async () => {
      n += 1;
      return { success: false, suppressed: true, reason: 'unsubscribed' };
    },
  });
  const out = await deliverOperatorSend(baseInput(), s.deps);
  assert.equal(out.email.state, 'suppressed');
  assert.equal(n, 1);
});

test('ENABLE_SMS off: sms reports channel-disabled and the transport is never touched', async () => {
  const s = spy();
  const out = await deliverOperatorSend(
    baseInput({ wantSms: true, sms: { enabled: false, consumer: OPTED_IN } }),
    s.deps,
  );
  assert.equal(out.sms.state, 'channel-disabled');
  assert.match(out.sms.reason, /ENABLE_SMS/);
  assert.equal(s.texts.length, 0, 'a disabled channel must not reach the provider');
});

test('both channels down is LOUD, and email delivery alone still counts as reached', async () => {
  const down = spy({ email: async () => ({ success: false, reason: 'fetch failed' }) });
  const bothBad = await deliverOperatorSend(
    baseInput({ wantSms: true, sms: { enabled: false, consumer: OPTED_IN } }),
    down.deps,
  );
  assert.equal(bothBad.reached, false);
  assert.equal(bothBad.loud, true);

  const up = spy();
  const oneGood = await deliverOperatorSend(
    baseInput({ wantSms: true, sms: { enabled: false, consumer: OPTED_IN } }),
    up.deps,
  );
  assert.equal(oneGood.email.state, 'delivered');
  assert.equal(oneGood.sms.state, 'channel-disabled');
  assert.equal(oneGood.reached, true);
  assert.equal(oneGood.loud, false);
});

test('double-tap: the second send is claimed away — exactly ONE email leaves', async () => {
  const s = spy();
  const first = await deliverOperatorSend(baseInput(), s.deps);
  const second = await deliverOperatorSend(baseInput(), s.deps);

  assert.equal(first.email.state, 'delivered');
  assert.equal(second.email.state, 'already-sent');
  assert.equal(s.emails.length, 1, 'a double-tap must not send twice');
  // "already sent" is not a failure — the buyer HAS the link.
  assert.equal(second.reached, true);
  assert.equal(second.loud, false);
});

test('the claim is per (link, channel, recipient) — a different cut or address sends again', async () => {
  const s = spy();
  await deliverOperatorSend(baseInput(), s.deps);
  // Different link (a different cut mints a different token).
  await deliverOperatorSend(
    baseInput({ target: { ...TARGET, url: `${SITE}/r/d/other` } }),
    s.deps,
  );
  // Same link, corrected address (a typo on a live call is a normal event).
  await deliverOperatorSend(baseInput({ email: 'fixed@example.test' }), s.deps);
  assert.equal(s.emails.length, 3);
});

test('sms rides its own claim — a delivered email never blocks the text', async () => {
  const s = spy();
  const out = await deliverOperatorSend(
    baseInput({ wantSms: true, sms: { enabled: true, consumer: OPTED_IN } }),
    s.deps,
  );
  assert.equal(out.email.state, 'delivered');
  assert.equal(out.sms.state, 'delivered');
  assert.equal(s.emails.length, 1);
  assert.equal(s.texts.length, 1);
  assert.equal(s.texts[0].to, '+15555550123');
});

test('a refusing sms provider is failed, never a silent success', async () => {
  const s = spy({ sms: async () => false });
  const out = await deliverOperatorSend(
    baseInput({ wantEmail: false, wantSms: true, sms: { enabled: true, consumer: OPTED_IN } }),
    s.deps,
  );
  assert.equal(out.sms.state, 'failed');
  assert.equal(out.reached, false);
  assert.equal(out.loud, true);
});

test('no email address is no-destination, not a failure to diagnose', async () => {
  const s = spy();
  const out = await deliverOperatorSend(baseInput({ email: '' }), s.deps);
  assert.equal(out.email.state, 'no-destination');
  assert.equal(s.emails.length, 0);
});

test('a failing stamp never downgrades a real delivery', async () => {
  const s = spy({ stampThrows: true });
  const out = await deliverOperatorSend(baseInput(), s.deps);
  assert.equal(out.email.state, 'delivered');
  assert.equal(out.reached, true);
  assert.equal(out.stamped, false); // honest about the stamp, honest about the send
});

test('a product-rail send with no resolved buyer still delivers (stamp is optional)', async () => {
  const s = spy();
  const out = await deliverOperatorSend(
    baseInput({ target: { rail: 'product', consumerId: '', cut: '', url: `${SITE}/shop/${PRODUCT_ID}` } }),
    s.deps,
  );
  assert.equal(out.email.state, 'delivered');
  assert.equal(out.stamped, false);
  assert.equal(s.stamps.length, 0);
});

// ---------------------------------------------------------------------------
// sendClaimKey — the identity of "this send"
// ---------------------------------------------------------------------------

test('the claim key separates channels, recipients and links', () => {
  const a = sendClaimKey({ url: `${SITE}/r/d/tok`, channel: 'email', recipient: 'Buyer@Example.test' });
  const b = sendClaimKey({ url: `${SITE}/r/d/tok`, channel: 'sms', recipient: 'buyer@example.test' });
  const c = sendClaimKey({ url: `${SITE}/r/d/other`, channel: 'email', recipient: 'buyer@example.test' });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  // Recipient casing is not a new send.
  assert.equal(a, sendClaimKey({ url: `${SITE}/r/d/tok`, channel: 'email', recipient: 'buyer@example.test' }));
});
