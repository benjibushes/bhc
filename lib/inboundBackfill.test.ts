import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  isBackfillCandidate,
  selectBackfillRows,
  matchReceivedEmail,
  runInboundBackfill,
  parseTs,
  BACKFILL_CAP_DEFAULT,
  type BackfillDeps,
  type ConversationRowLike,
} from './inboundBackfill';
import { CONTENT_UNRECOVERABLE_MARKER, CONTENT_FETCH_FAILED_MARKER } from './inboundContent';
import type { ReceivedEmailListItem } from './inboundContent';
import type { Classification } from './inboundClassify';

// All fixtures are synthetic — repo is public, never use real sender data.

const T0 = '2026-07-15T12:00:00.000Z';

function row(overrides: Partial<ConversationRowLike> = {}): ConversationRowLike {
  return {
    id: 'recRow1',
    Direction: 'inbound',
    From: 'Fake Buyer <fake-buyer@example.com>',
    Subject: 'Re: your half cow',
    Timestamp: T0,
    'Body Plain': '',
    ...overrides,
  };
}

function item(overrides: Partial<ReceivedEmailListItem> = {}): ReceivedEmailListItem {
  return {
    id: 're-1',
    from: 'fake-buyer@example.com',
    to: ['inbox@replies.example.com'],
    subject: 'Re: your half cow',
    createdAt: T0,
    messageId: '<m1@example.com>',
    ...overrides,
  };
}

const CLASSIFICATION: Classification = {
  senderType: 'buyer',
  objectionCategory: 'timing',
  sentiment: 'neutral',
  actionNeeded: 'ben-eyes',
  summary: 'synthetic summary',
};

function deps(overrides: Partial<BackfillDeps> = {}): BackfillDeps & {
  updates: Array<{ rowId: string; fields: Record<string, unknown> }>;
  classifyArgs: unknown[];
  fetchCalls: string[];
  sleeps: number[];
} {
  const updates: Array<{ rowId: string; fields: Record<string, unknown> }> = [];
  const fetchCalls: string[] = [];
  const sleeps: number[] = [];
  const classifyArgs: unknown[] = [];
  const state = {
    updates,
    fetchCalls,
    sleeps,
    classifyArgs,
  };
  const d: BackfillDeps = {
    listRows: async () => [row()],
    listReceived: async () => ({ ok: true, items: [item()] }),
    fetchContent: async (id: string) => {
      fetchCalls.push(id);
      return {
        ok: true,
        content: {
          text: 'recovered plain body',
          html: '<p>recovered plain body</p>',
          headers: { 'Message-Id': '<m1@example.com>' },
          messageId: '<m1@example.com>',
        },
      };
    },
    classify: async (opts) => {
      classifyArgs.push(opts);
      return CLASSIFICATION;
    },
    updateRow: async (rowId: string, fields: Record<string, unknown>) => {
      updates.push({ rowId, fields });
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    ...overrides,
  };
  return Object.assign(d, state);
}

// ── Selection ────────────────────────────────────────────────────────────────

test('selection: empty-body and fetch-failed-marker inbound email rows qualify', () => {
  assert.equal(isBackfillCandidate(row()), true);
  assert.equal(isBackfillCandidate(row({ Direction: 'Inbound' })), true, 'case-insensitive Direction');
  assert.equal(isBackfillCandidate(row({ Direction: 'outbound' })), false);
  assert.equal(isBackfillCandidate(row({ 'Body Plain': 'already has a body' })), false);
  assert.equal(
    isBackfillCandidate(row({ 'Body Plain': CONTENT_UNRECOVERABLE_MARKER })),
    false,
    'unrecoverable-stamped rows never re-qualify',
  );
  // COVERAGE CHANGE 2026-08-10 (recVUDVwrSvVrDZNz post-mortem): fetch-failed
  // marker rows are PENDING, not terminal — nobody ever cleared a marker by
  // hand, so a failed webhook fetch used to be permanent blindness.
  assert.equal(
    isBackfillCandidate(row({ 'Body Plain': CONTENT_FETCH_FAILED_MARKER })),
    true,
    'bare fetch-failed marker rows qualify',
  );
  assert.equal(
    isBackfillCandidate(row({ 'Body Plain': `${CONTENT_FETCH_FAILED_MARKER} [rid:re-fake-id]` })),
    true,
    'rid-bearing fetch-failed marker rows qualify',
  );
  assert.equal(isBackfillCandidate(row({ From: 'ig:some_handle' })), false, 'IG DM rows excluded');
  assert.equal(isBackfillCandidate(row({ From: 'no-at-sign' })), false);
  assert.equal(isBackfillCandidate({ id: '', Direction: 'inbound' } as any), false);
});

test('selection: REGRESSION recVUDVwrSvVrDZNz — pre-fix blind row shape (fields ABSENT, not empty strings) qualifies', () => {
  // Airtable omits empty fields entirely: no Body, no Body Plain, no Message
  // Id keys at all; Raw Headers is the literal string '{}'. Synthetic sender.
  const blind: ConversationRowLike = {
    id: 'recBlindRow',
    Direction: 'inbound',
    From: 'Fake Rancher <fake-rancher@example.com>',
    Subject: 'Re: Commission Invoice — synthetic',
    Timestamp: T0,
    'Raw Headers': '{}',
  };
  assert.equal(isBackfillCandidate(blind), true);
});

test('selection: cap respected (default 50)', () => {
  const rows = Array.from({ length: 60 }, (_, i) => row({ id: `recRow${i}` }));
  assert.equal(BACKFILL_CAP_DEFAULT, 50);
  assert.equal(selectBackfillRows(rows).length, 50);
  assert.equal(selectBackfillRows(rows, 10).length, 10);
});

// ── Matching ─────────────────────────────────────────────────────────────────

test('match: bare From must be identical (display-name wrapping ignored)', () => {
  assert.equal(matchReceivedEmail(row(), [item()])?.id, 're-1');
  assert.equal(matchReceivedEmail(row(), [item({ from: 'other@example.com' })]), null);
});

test('match: outside the time window → null', () => {
  const far = item({ createdAt: '2026-07-15T13:00:00.000Z' }); // +60min
  assert.equal(matchReceivedEmail(row(), [far]), null);
});

test('match: subject equality preferred, then nearest timestamp', () => {
  const wrongSubjectNear = item({ id: 're-near', subject: 'different', createdAt: '2026-07-15T12:00:10.000Z' });
  const rightSubjectFar = item({ id: 're-far', createdAt: '2026-07-15T12:05:00.000Z' });
  assert.equal(matchReceivedEmail(row(), [wrongSubjectNear, rightSubjectFar])?.id, 're-far');
  const nearer = item({ id: 're-a', createdAt: '2026-07-15T12:00:05.000Z' });
  const farther = item({ id: 're-b', createdAt: '2026-07-15T12:03:00.000Z' });
  assert.equal(matchReceivedEmail(row(), [farther, nearer])?.id, 're-a');
});

test('parseTs tolerates ISO-T and space-separated forms', () => {
  assert.equal(parseTs('2026-07-15T12:00:00.000Z'), Date.parse('2026-07-15T12:00:00.000Z'));
  assert.ok(Number.isFinite(parseTs('2026-07-15 12:00:00+00')));
  assert.ok(Number.isNaN(parseTs('')));
});

// ── Runner ───────────────────────────────────────────────────────────────────

test('recovered row: content + Message Id + classifier fields written, nothing else', async () => {
  const d = deps();
  const summary = await runInboundBackfill(d);
  assert.equal(summary.recovered, 1);
  assert.equal(summary.unrecoverable, 0);
  assert.equal(d.classifyArgs.length, 1);
  assert.equal(d.updates.length, 1);
  assert.deepEqual(Object.keys(d.updates[0].fields).sort(), [
    'AI Summary',
    'Action Needed',
    'Body',
    'Body Plain',
    'Message Id',
    'Objection Category',
    'Raw Headers',
    'Sender Type',
    'Sentiment',
  ]);
  assert.equal(d.updates[0].fields['Body Plain'], 'recovered plain body');
  assert.equal(d.updates[0].fields['Message Id'], '<m1@example.com>');
});

test('unmatched row: stamped unrecoverable, classifier NOT called', async () => {
  const d = deps({ listReceived: async () => ({ ok: true, items: [] }) });
  const summary = await runInboundBackfill(d);
  assert.equal(summary.recovered, 0);
  assert.equal(summary.unrecoverable, 1);
  assert.equal(d.classifyArgs.length, 0);
  assert.deepEqual(d.updates[0].fields, { 'Body Plain': CONTENT_UNRECOVERABLE_MARKER });
});

test('fetch 404 → unrecoverable; transient error → untouched for next run', async () => {
  const gone = deps({ fetchContent: async () => ({ ok: false, status: 404, error: 'gone' }) });
  const s1 = await runInboundBackfill(gone);
  assert.equal(s1.unrecoverable, 1);
  assert.deepEqual(gone.updates[0].fields, { 'Body Plain': CONTENT_UNRECOVERABLE_MARKER });

  const flaky = deps({ fetchContent: async () => ({ ok: false, error: 'timeout after 5000ms' }) });
  const s2 = await runInboundBackfill(flaky);
  assert.equal(s2.unrecoverable, 0);
  assert.equal(s2.skippedTransient, 1);
  assert.equal(flaky.updates.length, 0, 'transient failure must not stamp the row');
});

// ── rid path (2026-08-10): marker rows carry the exact Resend id ────────────

test('rid path: marker row fetches directly by rid — no listing match needed', async () => {
  const d = deps({
    listRows: async () => [
      row({ 'Body Plain': `${CONTENT_FETCH_FAILED_MARKER} [rid:re-direct-1]` }),
    ],
    listReceived: async () => ({ ok: true, items: [] }), // listing would find NOTHING
  });
  const summary = await runInboundBackfill(d);
  assert.equal(summary.recovered, 1);
  assert.equal(summary.unrecoverable, 0);
  assert.deepEqual(d.fetchCalls, ['re-direct-1']);
  assert.equal(d.updates[0].fields['Body Plain'], 'recovered plain body');
  assert.equal(d.updates[0].fields['Message Id'], '<m1@example.com>');
});

test('rid path: gone rid (404) falls back to the listing match', async () => {
  const d = deps({
    listRows: async () => [
      row({ 'Body Plain': `${CONTENT_FETCH_FAILED_MARKER} [rid:re-stale]` }),
    ],
  });
  const inner = d.fetchContent;
  d.fetchContent = async (id: string) => {
    if (id === 're-stale') {
      d.fetchCalls.push(id);
      return { ok: false, status: 404, error: 'gone' };
    }
    return inner(id);
  };
  const summary = await runInboundBackfill(d);
  assert.equal(summary.recovered, 1);
  assert.deepEqual(d.fetchCalls, ['re-stale', 're-1']);
});

test('rid path: transient rid failure leaves the marker row untouched for the next run', async () => {
  const d = deps({
    listRows: async () => [
      row({ 'Body Plain': `${CONTENT_FETCH_FAILED_MARKER} [rid:re-flaky]` }),
    ],
    fetchContent: async () => ({ ok: false, status: 503, error: 'resend receiving GET 503' }),
  });
  const summary = await runInboundBackfill(d);
  assert.equal(summary.skippedTransient, 1);
  assert.equal(summary.recovered, 0);
  assert.equal(d.updates.length, 0, 'transient rid failure must not stamp the row');
});

test('rid-less marker row: listing-match path; unmatched → unrecoverable replaces the marker', async () => {
  const d = deps({
    listRows: async () => [row({ 'Body Plain': CONTENT_FETCH_FAILED_MARKER })],
    listReceived: async () => ({ ok: true, items: [] }),
  });
  const summary = await runInboundBackfill(d);
  assert.equal(summary.unrecoverable, 1);
  assert.deepEqual(d.updates[0].fields, { 'Body Plain': CONTENT_UNRECOVERABLE_MARKER });
});

test('idempotent: rows with non-empty Body Plain are never touched', async () => {
  const d = deps({
    listRows: async () => [
      row({ id: 'recFull', 'Body Plain': 'existing body' }),
      row({ id: 'recMarked', 'Body Plain': CONTENT_UNRECOVERABLE_MARKER }),
    ],
  });
  const summary = await runInboundBackfill(d);
  assert.equal(summary.selected, 0);
  assert.equal(d.updates.length, 0);
  assert.equal(d.fetchCalls.length, 0);
});

test('cap respected in the runner + remaining reported for the re-run loop', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => row({ id: `recRow${i}` }));
  const d = deps({ listRows: async () => rows, cap: 5 });
  const summary = await runInboundBackfill(d);
  assert.equal(summary.selected, 5);
  assert.equal(summary.remaining, 2);
  assert.equal(d.updates.length, 5);
});

test('pacing: sleeps between rows with the configured pace', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => row({ id: `recRow${i}` }));
  const d = deps({ listRows: async () => rows, paceMs: 500 });
  await runInboundBackfill(d);
  assert.deepEqual(d.sleeps, [500, 500]);
});

test('dryRun: zero writes, zero classifier spend', async () => {
  const d = deps({ dryRun: true, listRows: async () => [row(), row({ id: 'recRow2', From: 'nobody@example.com' })] });
  const summary = await runInboundBackfill(d);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.recovered, 1);
  assert.equal(summary.unrecoverable, 1);
  assert.equal(d.updates.length, 0);
  assert.equal(d.classifyArgs.length, 0);
});

test('listing failure aborts WITHOUT stamping anything', async () => {
  const d = deps({ listReceived: async () => ({ ok: false, error: 'api down' }) });
  const summary = await runInboundBackfill(d);
  assert.equal(summary.ok, false);
  assert.equal(d.updates.length, 0);
});

// ── Boundary pins (grep-based, same pattern as the repo's other source pins) ─
// The backfill path must be CLASSIFIER-ONLY: no autoresponse, no staged-reply
// sending, no per-row Telegram. One summary operator signal in the ROUTE only.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const backfillLibSrc = readFileSync(path.join(HERE, 'inboundBackfill.ts'), 'utf8');
const backfillRouteSrc = readFileSync(
  path.join(HERE, '..', 'app', 'api', 'admin', 'backfill-inbound-bodies', 'route.ts'),
  'utf8',
);

test('PIN: no send call sites are reachable from the backfill lib', () => {
  for (const forbidden of [
    'sendEmail',
    'sendTelegramMessage',
    'autoRespond',
    'maybeAutoRespond',
    'readyToBuyEmail',
    'sendOperatorSignal',
    'guardedSend',
    '@/lib/email',
    '@/lib/telegram',
  ]) {
    assert.equal(
      backfillLibSrc.includes(forbidden),
      false,
      `lib/inboundBackfill.ts must not reference ${forbidden}`,
    );
  }
});

test('PIN: backfill route sends nothing except the single summary operator signal', () => {
  for (const forbidden of [
    'sendEmail',
    'sendTelegramMessage',
    'autoRespond',
    'maybeAutoRespond',
    '@/lib/email',
    '@/lib/telegram',
  ]) {
    assert.equal(
      backfillRouteSrc.includes(forbidden),
      false,
      `backfill route must not reference ${forbidden}`,
    );
  }
  const signalCalls = backfillRouteSrc.match(/sendOperatorSignal\(/g) || [];
  assert.equal(signalCalls.length, 1, 'exactly one summary signal call site');
  assert.match(backfillRouteSrc, /dryRun/, 'summary signal must be inside the non-dry-run path');
});

test('PIN: backfill route is double-latched (admin auth + env gate) and capped', () => {
  assert.match(backfillRouteSrc, /requireAdmin\(request\)/);
  assert.match(backfillRouteSrc, /INBOUND_BACKFILL_ENABLED/);
  assert.match(backfillRouteSrc, /BACKFILL_CAP_DEFAULT/);
});

// ── Nightly cron (2026-08-10) — same send boundaries, cron-authed, NO env
// latch (the latch is why 54 blind rows sat pending 7 days: the env var was
// never set and the manual route was never POSTed).
const backfillCronSrc = readFileSync(
  path.join(HERE, '..', 'app', 'api', 'cron', 'inbound-body-backfill', 'route.ts'),
  'utf8',
);

test('PIN: nightly backfill cron sends nothing except the single summary operator signal', () => {
  for (const forbidden of [
    'sendEmail',
    'sendTelegramMessage',
    'autoRespond',
    'maybeAutoRespond',
    '@/lib/email',
    '@/lib/telegram',
  ]) {
    assert.equal(
      backfillCronSrc.includes(forbidden),
      false,
      `backfill cron must not reference ${forbidden}`,
    );
  }
  const signalCalls = backfillCronSrc.match(/sendOperatorSignal\(/g) || [];
  assert.equal(signalCalls.length, 1, 'exactly one summary signal call site');
});

test('PIN: nightly backfill cron is cron-authed, capped, and NOT env-latched', () => {
  assert.match(backfillCronSrc, /requireCron\(request\)/);
  assert.match(backfillCronSrc, /withCronRun\('inbound-body-backfill'/);
  assert.match(backfillCronSrc, /BACKFILL_CAP_DEFAULT/);
  assert.equal(
    backfillCronSrc.includes('INBOUND_BACKFILL_ENABLED'),
    false,
    'self-heal must be default-ON — no env latch on the cron path',
  );
});
