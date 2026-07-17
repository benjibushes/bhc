// lib/replyAddressing.test.ts
//
// Regression coverage for the Reply-To addressing scheme, focused on the `prp`
// (cold rancher prospect) prefix added 2026-07-17. A prospect's reply MUST
// parse back to {type:'prp', recordId} so the inbound webhook can mark it
// rancher-side and keep it out of the buyer sales arm. Record-id case must be
// preserved (Airtable ids are case-sensitive).
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/replyAddressing.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReplyAddress, replyToFor, findReplyContext, REPLIES_DOMAIN } from './replyAddressing';

// ── prp: the new cold-prospect prefix ───────────────────────────────────────

test('prp- address parses to a prospect context', () => {
  const ctx = parseReplyAddress(`prp-recAbC123@${REPLIES_DOMAIN}`);
  assert.deepEqual(ctx, { type: 'prp', recordId: 'recAbC123' });
});

test('prp- preserves record-id case (Airtable ids are case-sensitive)', () => {
  const ctx = parseReplyAddress(`prp-recXyZ789@${REPLIES_DOMAIN}`);
  assert.equal(ctx?.recordId, 'recXyZ789');
});

test('prp- parses inside a "Name <addr>" wrapper', () => {
  const ctx = parseReplyAddress(`Ben — BuyHalfCow <prp-rec42@${REPLIES_DOMAIN}>`);
  assert.deepEqual(ctx, { type: 'prp', recordId: 'rec42' });
});

test('prp- prefix is case-insensitive but type normalizes to lowercase', () => {
  const ctx = parseReplyAddress(`PRP-recABC@${REPLIES_DOMAIN.toUpperCase()}`);
  assert.equal(ctx?.type, 'prp');
  assert.equal(ctx?.recordId, 'recABC');
});

test('replyToFor("prp", id) round-trips through parseReplyAddress', () => {
  const addr = replyToFor('prp', 'recRoundTrip1');
  const ctx = parseReplyAddress(addr);
  assert.deepEqual(ctx, { type: 'prp', recordId: 'recRoundTrip1' });
});

test('findReplyContext picks the prp address out of a multi-recipient To', () => {
  const ctx = findReplyContext([
    'someone-else@example.com',
    `prp-recPicked@${REPLIES_DOMAIN}`,
  ]);
  assert.deepEqual(ctx, { type: 'prp', recordId: 'recPicked' });
});

// ── existing prefixes still work (no regression) ────────────────────────────

test('ref/usr/rnc prefixes unaffected by adding prp', () => {
  assert.equal(parseReplyAddress(`ref-rec1@${REPLIES_DOMAIN}`)?.type, 'ref');
  assert.equal(parseReplyAddress(`usr-rec2@${REPLIES_DOMAIN}`)?.type, 'usr');
  assert.equal(parseReplyAddress(`rnc-rec3@${REPLIES_DOMAIN}`)?.type, 'rnc');
});

test('an unknown prefix still returns null', () => {
  assert.equal(parseReplyAddress(`zzz-rec9@${REPLIES_DOMAIN}`), null);
});

test('a foreign domain is ignored even with a valid-looking prp tag', () => {
  assert.equal(parseReplyAddress('prp-recABC@gmail.com'), null);
});
