// lib/smsKeywords.test.ts — STOP/HELP/START behave identically on every provider.
//
// These rules used to live inside app/api/webhooks/twilio-sms/route.ts, which
// npm test does not even run (the glob is lib/**). Extracting them here means
// the carrier-compliance layer is now actually covered — and covered ONCE, so a
// provider swap cannot leave two divergent copies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyKeyword, replyTextFor, keywordMutatesConsent, BRAND, SUPPORT_EMAIL } from './smsKeywords';
import { parseInboundSms } from './smsInbound';

// ─── STOP family ───────────────────────────────────────────────────────────

test('STOP keywords classify as stop', () => {
  for (const w of ['STOP', 'stop', 'Stop', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']) {
    assert.equal(classifyKeyword(w), 'stop', `${w} → stop`);
  }
});

test('STOP tolerates punctuation and trailing words', () => {
  assert.equal(classifyKeyword('STOP.'), 'stop');
  assert.equal(classifyKeyword('Stop!'), 'stop');
  assert.equal(classifyKeyword('  stop  '), 'stop');
  assert.equal(classifyKeyword('STOP please'), 'stop');
});

// ─── START / HELP / other ──────────────────────────────────────────────────

test('START keywords classify as start', () => {
  for (const w of ['START', 'start', 'UNSTOP', 'YES', 'RESUME']) {
    assert.equal(classifyKeyword(w), 'start', `${w} → start`);
  }
});

test('HELP keywords classify as help', () => {
  for (const w of ['HELP', 'help', 'INFO', 'Info?']) {
    assert.equal(classifyKeyword(w), 'help', `${w} → help`);
  }
});

test('anything else is other, including empty and emoji-only', () => {
  for (const w of ['', '   ', 'sounds good', '👍', '123', null, undefined]) {
    assert.equal(classifyKeyword(w as any), 'other', `${JSON.stringify(w)} → other`);
  }
});

// ─── Replies ───────────────────────────────────────────────────────────────

test('HELP reply carries brand, contact, rates notice and opt-out (CTIA)', () => {
  const text = replyTextFor('help') as string;
  assert.ok(text.includes(BRAND), 'brand');
  assert.ok(text.includes(SUPPORT_EMAIL), 'contact');
  assert.match(text, /rates may apply/i);
  assert.match(text, /Reply STOP to cancel/i);
});

test('START reply confirms re-subscription and repeats the opt-out', () => {
  const text = replyTextFor('start') as string;
  assert.ok(text.includes(BRAND));
  assert.match(text, /re-subscribed/i);
  assert.match(text, /Reply STOP to cancel/i);
});

test('STOP sends NOTHING — never text someone who just opted out', () => {
  assert.equal(replyTextFor('stop'), null);
});

test('other sends NOTHING — no auto-reply loops', () => {
  assert.equal(replyTextFor('other'), null);
});

// ─── Consent mutation surface ──────────────────────────────────────────────

test('only stop/start mutate consent state', () => {
  assert.equal(keywordMutatesConsent('stop'), true);
  assert.equal(keywordMutatesConsent('start'), true);
  assert.equal(keywordMutatesConsent('help'), false);
  assert.equal(keywordMutatesConsent('other'), false);
});

// ─── Cross-provider parity (the legal requirement, end to end) ─────────────

test('the same STOP text produces the same keyword + reply from every provider payload', () => {
  const payloads: Record<string, unknown> = {
    twilio: { From: '+13125550001', To: '+17204917819', Body: 'STOP', MessageSid: 'SM1' },
    telnyx: {
      data: {
        event_type: 'message.received',
        payload: { id: 't1', text: 'STOP', from: { phone_number: '+13125550001' }, to: [{ phone_number: '+17204917819' }] },
      },
    },
    plivo: { From: '+13125550001', To: '+17204917819', Text: 'STOP', MessageUUID: 'p1' },
    bandwidth: [
      { type: 'message-received', to: '+17204917819', message: { id: 'b1', from: '+13125550001', to: ['+17204917819'], text: 'STOP', direction: 'in' } },
    ],
  };
  for (const [name, raw] of Object.entries(payloads)) {
    const parsed = parseInboundSms(raw);
    assert.ok(parsed, `${name} must parse`);
    assert.equal(parsed!.provider, name);
    assert.equal(parsed!.from, '+13125550001', `${name} sender`);
    assert.equal(classifyKeyword(parsed!.body), 'stop', `${name} keyword`);
    assert.equal(replyTextFor(classifyKeyword(parsed!.body)), null, `${name} reply`);
  }
});

test('the same HELP text produces the identical reply string from every provider payload', () => {
  const payloads: unknown[] = [
    { From: '+1312', To: '+1720', Body: 'HELP' },
    { data: { event_type: 'message.received', payload: { text: 'HELP', from: { phone_number: '+1312' }, to: [{ phone_number: '+1720' }] } } },
    { From: '+1312', To: '+1720', Text: 'HELP' },
    [{ type: 'message-received', to: '+1720', message: { from: '+1312', to: ['+1720'], text: 'HELP' } }],
  ];
  const replies = payloads.map((p) => replyTextFor(classifyKeyword(parseInboundSms(p)!.body)));
  assert.equal(new Set(replies).size, 1, 'all four providers must produce ONE reply string');
  assert.ok(replies[0]!.includes(BRAND));
});
