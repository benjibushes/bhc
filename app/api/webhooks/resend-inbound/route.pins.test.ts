import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Source pins for the inbound webhook (same grep-based pattern as the repo's
// other boundary pins — the route file can't be imported under tsx --test
// because App Router route files only export HTTP handlers and pull the
// full Airtable/Telegram stack at module load).
//
// WHAT THESE PROTECT (2026-08-03): Resend's `email.received` event carries no
// body — content must be fetched by data.email_id. These pins keep the fetch
// wired, fail-soft, and ordered BEFORE classification, and keep the token
// path authoritative over the From-match identity fallback.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'route.ts'), 'utf8');

test('PIN: payload-with-content path unchanged — pluck still reads d.text/d.html first', () => {
  assert.match(src, /text: d\.text \|\| ''/);
  assert.match(src, /html: d\.html \|\| ''/);
});

test('PIN: content fetch fires ONLY when both text and html are blank and an email id exists', () => {
  assert.match(
    src,
    /if \(!String\(text\)\.trim\(\) && !String\(html\)\.trim\(\) && emailId\) \{/,
    'fetch guard must require blank text AND blank html AND an email id',
  );
  // 2026-08-10: single attempt → retried fetch. One transient Resend hiccup
  // must never blind a row permanently.
  assert.match(src, /fetchReceivedEmailContentWithRetry\(emailId\)/);
});

test('PIN: fetch failure fails SOFT — envelope row still written, with the visible marker', () => {
  assert.match(
    src,
    /contentFetchFailed && !bodyForClassify \? contentFetchFailedMarker\(emailId\) : \(text \|\| bodyForClassify\)/,
    'Body Plain must carry the rid-bearing marker exactly when the fetch failed and no content exists',
  );
  assert.match(src, /CONTENT FETCH FAILED/, 'loud console.error on fetch failure');
});

test('PIN: classifier runs AFTER content resolution', () => {
  const fetchIdx = src.indexOf('fetchReceivedEmailContentWithRetry(emailId)');
  const classifyIdx = src.indexOf('classifyInboundReply({');
  assert.ok(fetchIdx > -1 && classifyIdx > -1);
  assert.ok(fetchIdx < classifyIdx, 'content fetch must precede classification');
  assert.equal(src.includes('async function classifyReply'), false, 'local classifier removed — lib/inboundClassify is the single brain');
});

test('PIN: identity fallback only fires with NO token context and NO resolved links', () => {
  assert.match(
    src,
    /if \(!context && !links\.referralId && !links\.threadId && !links\.consumerId && !links\.rancherId\) \{/,
  );
  assert.match(src, /applyIdentityFallback\(\{ context, links, match: identityMatch \}\)/);
  // The deterministic type override must be scoped to the applied fallback
  // and must never fire for prospect (prp) replies.
  assert.match(src, /if \(identityApplied && identityMatch\) \{/);
});

test('PIN: svix signature verification untouched (fail-closed in prod)', () => {
  assert.match(src, /verifySvixSignature\(\{/);
  assert.match(src, /RESEND_INBOUND_WEBHOOK_SECRET unset in prod — refusing all requests/);
  assert.match(src, /invalid signature/);
});

test('PIN: Message Id is persisted on the Conversations row', () => {
  assert.match(src, /'Message Id': headerValue\(headers, 'message-id'\) \|\| envelopeMessageId \|\| ''/);
});

test('PIN: envelope message_id restores the dedup paths when payload headers are empty', () => {
  assert.match(src, /if \(!headerValue\(headers, 'message-id'\) && envelopeMessageId\) \{/);
});
