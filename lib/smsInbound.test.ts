// lib/smsInbound.test.ts — every provider's inbound payload collapses to one shape.
//
// The payloads below are the vendors' own documented samples (fetched
// 2026-07-30; URLs in lib/smsInbound.ts). If a buyer texts STOP, the handler
// must see the same {from, body} no matter whose wire it came off — that's the
// whole legal argument for this module existing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInboundSms } from './smsInbound';

// ─── Twilio (form-urlencoded) ──────────────────────────────────────────────

test('twilio: From/To/Body/MessageSid form fields', () => {
  const got = parseInboundSms({
    From: '+13125550001',
    To: '+17202401234',
    Body: 'STOP',
    MessageSid: 'SM1234567890abcdef',
    AccountSid: 'AC1',
  });
  assert.deepEqual(got, {
    provider: 'twilio',
    from: '+13125550001',
    to: '+17202401234',
    body: 'STOP',
    providerMessageId: 'SM1234567890abcdef',
  });
});

test('twilio: SmsMessageSid alias is accepted', () => {
  const got = parseInboundSms({ From: '+13125550001', To: '+1720', Body: 'HELP', SmsMessageSid: 'SM9' });
  assert.equal(got?.provider, 'twilio');
  assert.equal(got?.providerMessageId, 'SM9');
});

// ─── Telnyx (JSON envelope) ────────────────────────────────────────────────

test('telnyx: data.payload shape from the receive-message docs', () => {
  const got = parseInboundSms({
    data: {
      event_type: 'message.received',
      id: 'b301ed3f-1490-491f-995f-6e64e69674d4',
      payload: {
        direction: 'inbound',
        from: { carrier: 'T-Mobile USA', phone_number: '+13125550001' },
        id: '84cca175-9755-4859-b67f-4730d7f58aa3',
        record_type: 'message',
        text: 'STOP',
        to: [{ carrier: 'Telnyx', phone_number: '+17202401234' }],
        type: 'SMS',
      },
      record_type: 'event',
    },
    meta: { attempt: 1 },
  });
  assert.deepEqual(got, {
    provider: 'telnyx',
    from: '+13125550001',
    to: '+17202401234',
    body: 'STOP',
    providerMessageId: '84cca175-9755-4859-b67f-4730d7f58aa3',
  });
});

test('telnyx: a delivery receipt is NOT an inbound message', () => {
  const got = parseInboundSms({
    data: {
      event_type: 'message.finalized',
      payload: {
        direction: 'outbound',
        from: { phone_number: '+17202401234' },
        id: 'x',
        text: 'deposit ready',
        to: [{ phone_number: '+13125550001', status: 'delivered' }],
      },
    },
  });
  assert.equal(got, null, 'a DLR must never be classified as a buyer texting');
});

// ─── Plivo (form-urlencoded) ───────────────────────────────────────────────

test('plivo: From/To/Text form fields', () => {
  const got = parseInboundSms({
    From: '13125550001',
    To: '17202401234',
    Text: 'STOP',
    Type: 'sms',
    MessageUUID: 'db3ce55a-7f1d-11e1-8ea7-1231380bc196',
  });
  assert.deepEqual(got, {
    provider: 'plivo',
    from: '13125550001',
    to: '17202401234',
    body: 'STOP',
    providerMessageId: 'db3ce55a-7f1d-11e1-8ea7-1231380bc196',
  });
});

test('plivo: MessageUUID is optional (docs only guarantee From/To/Text)', () => {
  const got = parseInboundSms({ From: '13125550001', To: '17202401234', Text: 'help' });
  assert.equal(got?.provider, 'plivo');
  assert.equal(got?.body, 'help');
  assert.equal(got?.providerMessageId, '');
});

test('plivo Text and twilio Body are never confused for each other', () => {
  assert.equal(parseInboundSms({ From: '+1', To: '+2', Text: 'a' })?.provider, 'plivo');
  assert.equal(parseInboundSms({ From: '+1', To: '+2', Body: 'a' })?.provider, 'twilio');
});

// ─── Bandwidth (JSON array of events) ──────────────────────────────────────

test('bandwidth: message-received event inside a JSON array', () => {
  const got = parseInboundSms([
    {
      time: '2025-01-06T15:43:35.502180Z',
      type: 'message-received',
      to: '+17202401234',
      description: 'Incoming message received',
      message: {
        id: '14762070468292kw2fuqty55yp2b2',
        owner: '+17202401234',
        applicationId: '93de2206-9669-4e07-948d-329f4b722ee2',
        segmentCount: 1,
        direction: 'in',
        to: ['+17202401234'],
        from: '+13125550001',
        text: 'STOP',
      },
    },
  ]);
  assert.deepEqual(got, {
    provider: 'bandwidth',
    from: '+13125550001',
    to: '+17202401234',
    body: 'STOP',
    providerMessageId: '14762070468292kw2fuqty55yp2b2',
  });
});

test('bandwidth: a delivery-receipt-only batch yields null', () => {
  const got = parseInboundSms([
    { type: 'message-delivered', to: '+1', message: { id: 'x', from: '+2', to: ['+1'], text: 'hi', direction: 'out' } },
  ]);
  assert.equal(got, null);
});

// ─── Garbage in, null out (never an exception) ─────────────────────────────

test('unrecognized / empty payloads return null instead of throwing', () => {
  assert.equal(parseInboundSms(null), null);
  assert.equal(parseInboundSms(undefined), null);
  assert.equal(parseInboundSms(''), null);
  assert.equal(parseInboundSms(42), null);
  assert.equal(parseInboundSms({}), null);
  assert.equal(parseInboundSms([]), null);
  assert.equal(parseInboundSms({ hello: 'world' }), null);
  // Shape matches but the sender is missing → unusable, must not half-parse.
  assert.equal(parseInboundSms({ Body: 'STOP' }), null);
  assert.equal(parseInboundSms({ Text: 'STOP' }), null);
});

test('values are trimmed so " STOP " still reaches the classifier intact', () => {
  const got = parseInboundSms({ From: ' +13125550001 ', To: ' +1720 ', Body: '  STOP  ', MessageSid: ' SM1 ' });
  assert.equal(got?.from, '+13125550001');
  assert.equal(got?.body, 'STOP');
  assert.equal(got?.providerMessageId, 'SM1');
});
