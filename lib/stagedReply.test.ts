// lib/stagedReply.test.ts
//
// C3 — pins the pure pieces of the shared staged-reply send path (lifted
// from the Telegram bsend handler): the link allowlist, From parsing, the
// threading-header extraction, and the waiting/sendable predicates. The
// send itself is I/O and stays covered by the guard logic it delegates to.
// All fixtures synthetic (public repo).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeStagedReplyLinks,
  replyAddressFromFrom,
  inReplyToFromRawHeaders,
  isReplyWaiting,
  isReplySendable,
} from './stagedReply';

test('link sanitizer keeps cal.com / buyhalfcow.com (and subdomains), strips the rest', () => {
  const draft =
    'Book here https://cal.com/test-slot or https://www.buyhalfcow.com/shop — ' +
    'never https://evil.example.com/phish and not https://evilcal.com/x either';
  const out = sanitizeStagedReplyLinks(draft);
  assert.match(out, /https:\/\/cal\.com\/test-slot/);
  assert.match(out, /https:\/\/www\.buyhalfcow\.com\/shop/);
  assert.ok(!out.includes('evil.example.com'));
  assert.ok(!out.includes('evilcal.com'));
  assert.equal((out.match(/\[link removed\]/g) || []).length, 2);
});

test('From parsing: display-name form and bare-address form both resolve', () => {
  assert.equal(replyAddressFromFrom('Test Person <TEST@Example.com>'), 'test@example.com');
  assert.equal(replyAddressFromFrom('  plain@example.com '), 'plain@example.com');
  assert.equal(replyAddressFromFrom(''), '');
});

test('threading header comes out of Raw Headers in any casing; garbage is safe', () => {
  assert.equal(
    inReplyToFromRawHeaders(JSON.stringify({ 'Message-ID': '<abc@mx>' })),
    '<abc@mx>',
  );
  assert.equal(
    inReplyToFromRawHeaders(JSON.stringify({ 'message-id': '<lower@mx>' })),
    '<lower@mx>',
  );
  assert.equal(inReplyToFromRawHeaders('not json'), '');
  assert.equal(inReplyToFromRawHeaders(undefined), '');
});

test('waiting = staged/escalated variants; sendable = staged WITH a draft', () => {
  assert.equal(isReplyWaiting('staged'), true);
  assert.equal(isReplyWaiting('escalated'), true);
  assert.equal(isReplyWaiting('escalated (path sent)'), true);
  assert.equal(isReplyWaiting('sent'), false);
  assert.equal(isReplyWaiting('auto-sent'), false);
  assert.equal(isReplyWaiting(''), false);

  assert.equal(isReplySendable('staged', 'hi there'), true);
  assert.equal(isReplySendable('staged', '  '), false);
  assert.equal(isReplySendable('escalated', 'hi there'), false);
});
