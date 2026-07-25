import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideSetupLinkDelivery,
  normalizeRancherEmail,
  setupLinkResendKey,
  SETUP_LINK_EMAILED_MESSAGE,
  SETUP_LINK_RESEND_LIMIT,
} from './rancherSetupLinkDelivery';

// THE ATTACK THIS FENCES OFF:
//   Ranch names and states are public (every ranch is on /map with a page at
//   /ranchers/<slug>). Until 2026-07-24 typing a known ranch's name + state
//   into /apply returned a 60-day rancher-setup token for that record —
//   their prices, fulfillment settings and Stripe Connect entry point.
//   Only an exact match on the record's own primary Email may return a token.

const RECORD_EMAIL = 'jesse@renickvalley.com';

test('ranch+state match NEVER returns a token — ranch name and state are public', () => {
  assert.equal(
    decideSetupLinkDelivery({
      matchedBy: 'ranch+state',
      submittedEmail: 'attacker@evil.example',
      recordEmail: RECORD_EMAIL,
    }),
    'email-only',
  );
});

test('phone match never returns a token — a phone is sometimes public too', () => {
  assert.equal(
    decideSetupLinkDelivery({
      matchedBy: 'phone',
      submittedEmail: 'attacker@evil.example',
      recordEmail: RECORD_EMAIL,
    }),
    'email-only',
  );
});

test('team-email match is email-only — the primary owner holds the prices and payouts', () => {
  assert.equal(
    decideSetupLinkDelivery({
      matchedBy: 'team',
      submittedEmail: 'ranchhand@renickvalley.com',
      recordEmail: RECORD_EMAIL,
    }),
    'email-only',
  );
});

test('website-host match (self-submit secondary tier) is email-only — a website is public', () => {
  assert.equal(
    decideSetupLinkDelivery({
      matchedBy: 'website',
      submittedEmail: 'attacker@evil.example',
      recordEmail: RECORD_EMAIL,
    }),
    'email-only',
  );
});

test('exact email match returns the token — a genuine returning rancher is not slowed down', () => {
  assert.equal(
    decideSetupLinkDelivery({
      matchedBy: 'email',
      submittedEmail: RECORD_EMAIL,
      recordEmail: RECORD_EMAIL,
    }),
    'return-token',
  );
});

test('case differences still match — JESSE@Renickvalley.COM is the same rancher', () => {
  assert.equal(
    decideSetupLinkDelivery({
      matchedBy: 'email',
      submittedEmail: 'JESSE@Renickvalley.COM',
      recordEmail: RECORD_EMAIL,
    }),
    'return-token',
  );
});

test('whitespace differences still match — padded and inner-space stored addresses', () => {
  assert.equal(
    decideSetupLinkDelivery({
      matchedBy: 'email',
      submittedEmail: '  jesse@renickvalley.com  ',
      recordEmail: RECORD_EMAIL,
    }),
    'return-token',
  );
  // Real shape in this base: a stored address with INNER whitespace
  // (ZK Ranches' "zach@zkranches.com\n" class). Both sides normalize.
  assert.equal(
    decideSetupLinkDelivery({
      matchedBy: 'email',
      submittedEmail: 'jesse@renickvalley.com',
      recordEmail: 'jesse@renick valley.com\n',
    }),
    'return-token',
  );
  assert.equal(
    decideSetupLinkDelivery({
      matchedBy: 'email',
      submittedEmail: 'jesse@renickvalley.com',
      recordEmail: '\tJesse@RenickValley.com \n',
    }),
    'return-token',
  );
});

test("a mislabeled 'email' match whose addresses differ still fails closed", () => {
  // Belt-and-braces: the tier says email but the record's address is not the
  // one that was typed. No token.
  assert.equal(
    decideSetupLinkDelivery({
      matchedBy: 'email',
      submittedEmail: 'attacker@evil.example',
      recordEmail: RECORD_EMAIL,
    }),
    'email-only',
  );
});

test('a record with no email on file can never yield a token', () => {
  for (const recordEmail of ['', '   ', null, undefined]) {
    assert.equal(
      decideSetupLinkDelivery({
        matchedBy: 'email',
        submittedEmail: 'attacker@evil.example',
        recordEmail,
      }),
      'email-only',
      String(recordEmail),
    );
  }
});

test('a blank submitted email can never yield a token', () => {
  for (const submittedEmail of ['', '   ', null, undefined]) {
    assert.equal(
      decideSetupLinkDelivery({
        matchedBy: 'email',
        submittedEmail,
        recordEmail: '',
      }),
      'email-only',
      String(submittedEmail),
    );
  }
});

test('an unknown or missing match signal fails closed', () => {
  for (const matchedBy of [null, undefined, 'sms' as any, '' as any]) {
    assert.equal(
      decideSetupLinkDelivery({
        matchedBy,
        submittedEmail: RECORD_EMAIL,
        recordEmail: RECORD_EMAIL,
      }),
      'email-only',
      String(matchedBy),
    );
  }
});

test('normalizeRancherEmail matches lib/airtable._normalizeEmail exactly', () => {
  assert.equal(normalizeRancherEmail('  Zach@ZKRanches.com\n'), 'zach@zkranches.com');
  assert.equal(normalizeRancherEmail('za ch@zkranches.com'), 'zach@zkranches.com');
  assert.equal(normalizeRancherEmail(null), '');
  assert.equal(normalizeRancherEmail(undefined), '');
});

test('the resend bucket is keyed on the record, not the caller', () => {
  // Keyed on the record id so rotating IPs cannot bomb one rancher's inbox.
  assert.equal(setupLinkResendKey('recABC123'), 'setup-link-existing:recABC123');
  assert.notEqual(setupLinkResendKey('recABC123'), setupLinkResendKey('recXYZ789'));
  assert.equal(SETUP_LINK_RESEND_LIMIT.requests, 2);
  assert.equal(SETUP_LINK_RESEND_LIMIT.window, '24h');
});

test('the neutral message names neither the address on file nor the matched field', () => {
  assert.match(SETUP_LINK_EMAILED_MESSAGE, /already registered/i);
  assert.match(SETUP_LINK_EMAILED_MESSAGE, /email on file/i);
  // The ONLY address it may name is our own support inbox — never the
  // rancher's, and never the field that matched.
  const addresses = SETUP_LINK_EMAILED_MESSAGE.match(/[\w.+-]+@[\w.-]+/g) || [];
  assert.deepEqual(addresses, ['ben@buyhalfcow.com']);
  for (const leak of ['phone', 'ranch name', 'state', 'matched']) {
    assert.equal(
      SETUP_LINK_EMAILED_MESSAGE.toLowerCase().includes(leak),
      false,
      `message must not leak "${leak}"`,
    );
  }
});

test('the neutral message stays true when nothing was actually sent', () => {
  // The body is CONSTANT across sent / throttled / send-failed /
  // no-address-on-file, so it must carry a path that works in all four —
  // otherwise a real rancher whose record has no email on file is dead-ended.
  assert.match(SETUP_LINK_EMAILED_MESSAGE, /if it doesn't arrive/i);
});
