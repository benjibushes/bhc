import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchReceivedEmailContent,
  fetchReceivedEmailContentWithRetry,
  listReceivedEmails,
  normalizeHeaders,
  headerValue,
  htmlToPlain,
  contentFetchFailedMarker,
  isContentFetchFailedMarker,
  parseMarkerRid,
  CONTENT_FETCH_FAILED_MARKER,
  CONTENT_UNRECOVERABLE_MARKER,
} from './inboundContent';

// All fixtures are synthetic — repo is public, never use real sender data.

const okJson = (body: any) => ({ ok: true, status: 200, json: async () => body });
const errJson = (status: number) => ({ ok: false, status, json: async () => ({ message: 'nope' }) });

// ── Marker pins ──────────────────────────────────────────────────────────────
// Operators + the backfill's idempotency scan key off these EXACT strings —
// changing them silently re-hides blind rows.

test('markers are pinned exactly', () => {
  assert.equal(CONTENT_FETCH_FAILED_MARKER, '[content fetch failed — see inbox]');
  assert.equal(CONTENT_UNRECOVERABLE_MARKER, '[content unrecoverable]');
});

// ── fetchReceivedEmailContent ────────────────────────────────────────────────

test('fetch success: returns text/html/headers/messageId from the receiving API', async () => {
  const calls: string[] = [];
  const res = await fetchReceivedEmailContent('re-abc123', {
    apiKey: 'test-key',
    fetchImpl: async (url: string) => {
      calls.push(url);
      return okJson({
        id: 're-abc123',
        text: 'plain body',
        html: '<p>plain body</p>',
        headers: { 'Message-ID': '<mid-1@example.com>', 'Return-Path': 'fake@example.com' },
        message_id: '<mid-1@example.com>',
      });
    },
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.content.text, 'plain body');
  assert.equal(res.content.html, '<p>plain body</p>');
  assert.equal(res.content.messageId, '<mid-1@example.com>');
  assert.equal(headerValue(res.content.headers, 'message-id'), '<mid-1@example.com>');
  assert.match(calls[0], /^https:\/\/api\.resend\.com\/emails\/receiving\/re-abc123$/);
});

test('fetch failure: non-200 fails soft with status, never throws', async () => {
  const res = await fetchReceivedEmailContent('re-gone', {
    apiKey: 'test-key',
    fetchImpl: async () => errJson(404),
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 404);
});

test('fetch timeout: aborts and fails soft', async () => {
  const res = await fetchReceivedEmailContent('re-slow', {
    apiKey: 'test-key',
    timeoutMs: 20,
    fetchImpl: (_url: string, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }) as any,
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /timeout/);
});

test('fetch without api key: fails soft without calling the network', async () => {
  let called = 0;
  const res = await fetchReceivedEmailContent('re-x', {
    apiKey: '',
    fetchImpl: async () => {
      called++;
      return okJson({});
    },
  });
  assert.equal(res.ok, false);
  assert.equal(called, 0);
});

test('fetch with blank id: fails soft without calling the network', async () => {
  let called = 0;
  const res = await fetchReceivedEmailContent('  ', {
    apiKey: 'test-key',
    fetchImpl: async () => {
      called++;
      return okJson({});
    },
  });
  assert.equal(res.ok, false);
  assert.equal(called, 0);
});

// ── listReceivedEmails ───────────────────────────────────────────────────────

test('list paginates with the after cursor until a short page', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    id: `re-${i}`,
    from: 'fake@example.com',
    to: ['inbox@replies.example.com'],
    subject: `s${i}`,
    created_at: '2026-08-01T00:00:00.000Z',
    message_id: `<m${i}@example.com>`,
  }));
  const page2 = [
    {
      id: 're-100',
      from: 'fake2@example.com',
      to: ['inbox@replies.example.com'],
      subject: 'last',
      created_at: '2026-08-01T01:00:00.000Z',
      message_id: '<m100@example.com>',
    },
  ];
  const urls: string[] = [];
  const res = await listReceivedEmails({
    apiKey: 'test-key',
    fetchImpl: async (url: string) => {
      urls.push(url);
      return okJson({ data: urls.length === 1 ? page1 : page2 });
    },
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.items.length, 101);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /after=re-99/);
});

test('list failure fails soft', async () => {
  const res = await listReceivedEmails({ apiKey: 'test-key', fetchImpl: async () => errJson(500) });
  assert.equal(res.ok, false);
});

// ── helpers ──────────────────────────────────────────────────────────────────

test('normalizeHeaders handles object, {name,value} array, and junk', () => {
  assert.deepEqual(normalizeHeaders({ A: 'x' }), { A: 'x' });
  assert.deepEqual(
    normalizeHeaders([
      { name: 'Message-Id', value: '<m@example.com>' },
      { name: '', value: 'dropped' },
    ]),
    { 'Message-Id': '<m@example.com>' },
  );
  assert.deepEqual(normalizeHeaders(null), {});
  assert.deepEqual(normalizeHeaders('nope'), {});
});

test('headerValue is case-insensitive', () => {
  assert.equal(headerValue({ 'Message-ID': 'x' }, 'message-id'), 'x');
  assert.equal(headerValue({}, 'message-id'), '');
});

test('htmlToPlain strips tags, styles, and entities', () => {
  assert.equal(
    htmlToPlain('<style>b{}</style><p>Hi &amp; welcome<br>to the ranch</p>'),
    'Hi & welcome to the ranch',
  );
});

// ── rid-bearing marker helpers (2026-08-10) ──────────────────────────────────
// The webhook embeds the Resend received-email id in the fetch-failed marker
// so the backfill can fetch content directly instead of fuzzy-matching the
// listing. Bare markers (pre-existing rows) must keep parsing cleanly.

test('contentFetchFailedMarker embeds the rid; bare form without one', () => {
  assert.equal(
    contentFetchFailedMarker('re-abc-123'),
    `${CONTENT_FETCH_FAILED_MARKER} [rid:re-abc-123]`,
  );
  assert.equal(contentFetchFailedMarker(''), CONTENT_FETCH_FAILED_MARKER);
  assert.equal(contentFetchFailedMarker(undefined), CONTENT_FETCH_FAILED_MARKER);
});

test('isContentFetchFailedMarker: bare + rid forms yes; unrecoverable + real bodies no', () => {
  assert.equal(isContentFetchFailedMarker(CONTENT_FETCH_FAILED_MARKER), true);
  assert.equal(isContentFetchFailedMarker(contentFetchFailedMarker('re-x')), true);
  assert.equal(isContentFetchFailedMarker(CONTENT_UNRECOVERABLE_MARKER), false);
  assert.equal(isContentFetchFailedMarker('a real reply body'), false);
  assert.equal(isContentFetchFailedMarker(''), false);
});

test('parseMarkerRid round-trips; bare marker and junk give empty string', () => {
  assert.equal(parseMarkerRid(contentFetchFailedMarker('re-abc-123')), 're-abc-123');
  assert.equal(parseMarkerRid(CONTENT_FETCH_FAILED_MARKER), '');
  assert.equal(parseMarkerRid('no marker here'), '');
  assert.equal(parseMarkerRid(undefined), '');
});

// ── fetchReceivedEmailContentWithRetry (2026-08-10) ──────────────────────────
// One transient hiccup (timeout / 5xx / the email.received-outruns-storage
// 404 race) must not blind the row permanently; a dead key (401) must not
// burn the lambda budget retrying.

test('retry: transient failure then success — retries with backoff, returns content', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const res = await fetchReceivedEmailContentWithRetry('re-retry-1', {
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return errJson(500);
      return okJson({ text: 'second try body', html: '', headers: {}, message_id: '<m2@example.com>' });
    },
    sleep: async (ms: number) => { sleeps.push(ms); },
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.content.text, 'second try body');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [400], 'backoff before the second attempt only');
});

test('retry: 404 is retried (ingest race) and can recover', async () => {
  let calls = 0;
  const res = await fetchReceivedEmailContentWithRetry('re-race-1', {
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls++;
      if (calls < 3) return errJson(404);
      return okJson({ text: 'stored now', html: '', headers: {}, message_id: '<m3@example.com>' });
    },
    sleep: async () => {},
  });
  assert.equal(res.ok, true);
  assert.equal(calls, 3);
});

test('retry: exhausted attempts return the LAST failure', async () => {
  let calls = 0;
  const res = await fetchReceivedEmailContentWithRetry('re-dead-1', {
    apiKey: 'test-key',
    fetchImpl: async () => { calls++; return errJson(503); },
    sleep: async () => {},
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 503);
  assert.equal(calls, 3, 'default 3 attempts');
});

test('retry: 401 (dead key) is NOT retried', async () => {
  let calls = 0;
  const res = await fetchReceivedEmailContentWithRetry('re-key-dead', {
    apiKey: 'test-key',
    fetchImpl: async () => { calls++; return errJson(401); },
    sleep: async () => { throw new Error('must not sleep on a non-retryable failure'); },
  });
  assert.equal(res.ok, false);
  assert.equal(calls, 1);
});
