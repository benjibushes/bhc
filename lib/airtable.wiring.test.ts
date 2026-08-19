import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { l1TtlMs, l2TtlMs } from './airtableCachePolicy';
import { isAirtableRateLimitError } from './airtable';
import { AirtableTimeoutError } from './airtableTimeout';

// Source pins for the read-path storm fix (capacity audit 2026-08-19).
//
// lib/airtableBackoff.test.ts, lib/singleFlight.test.ts and
// lib/airtableCachePolicy.test.ts pin the three PRIMITIVES in isolation. These
// pins prove lib/airtable.ts actually USES them — without this file, someone
// could delete the single-flight wrapper or re-hardcode a TTL and every unit
// test would still pass. (Grep-based because lib/airtable.ts constructs a live
// Airtable client at module load; the same convention as the route.pins tests.)
//
// THE FAILURE BEING PREVENTED: a rate-limit burst that becomes self-sustaining.
// Concurrent cold reads all full-scan → >5 req/s → Airtable locks the whole
// base for 30s → every instance backs off by the SAME deterministic amount →
// they all wake together and re-earn the lockout.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'airtable.ts'), 'utf8');

// ── Single-flight ────────────────────────────────────────────────────────

test('PIN: getAllRecords wraps the cached read path in singleFlight', () => {
  assert.match(src, /import \{ singleFlight \} from '\.\/singleFlight'/);
  const idx = src.indexOf('export async function getAllRecords(');
  assert.ok(idx > -1, 'getAllRecords must still exist');
  const body = src.slice(idx, src.indexOf('\n}\n', idx));
  assert.match(body, /singleFlight\(key,/, 'the cacheable read path must be coalesced by cache key');
});

test('PIN: the coalesced flight covers the L2 lookup AND the Airtable fetch, not just one', () => {
  const idx = src.indexOf('return await singleFlight(key,');
  assert.ok(idx > -1, 'the single-flight wrapper must be the return value of the cached path');
  const flight = src.slice(idx, src.indexOf('\n    });', idx));
  assert.match(flight, /sharedCacheGet/, 'the shared-cache read must be inside the flight');
  assert.match(flight, /_fetchAndShape\(/, 'the Airtable scan must be inside the flight');
  assert.match(flight, /sharedCacheSet/, 'the shared-cache write must be inside the flight');
});

test('PIN: the UNCACHED path is deliberately NOT coalesced (filtered reads must stay live)', () => {
  // Filtered/projected/limited reads and every non-allowlisted table
  // (Consumers, Referrals, Payments) go straight to Airtable. Coalescing them
  // would let a read that started before a write serve a caller that arrived
  // after it — a capacity/money hazard.
  assert.match(src, /if \(!key\) return await _fetchAndShape\(/);
});

// ── Per-table, per-layer TTLs ────────────────────────────────────────────

test('PIN: TTLs come from the policy module — no hardcoded CACHE_TTL_MS survives', () => {
  assert.match(src, /import \{[^}]*l1TtlMs[^}]*l2TtlMs[^}]*\} from '\.\/airtableCachePolicy'/);
  assert.doesNotMatch(src, /const CACHE_TTL_MS\s*=/, 'the single blanket TTL constant must be gone');
});

test('PIN: L1 expiry uses l1TtlMs and the shared write uses l2TtlMs (they must not be swapped)', () => {
  assert.match(src, /Date\.now\(\) - hit\.ts < l1TtlMs\(tableName\)/);
  assert.match(src, /sharedCacheSet\(_redisCacheKey\(tableName\), data, l2TtlMs\(tableName\)\)/);
  // And the direction of the split must hold for the storm table.
  assert.ok(l2TtlMs('Ranchers') > l1TtlMs('Ranchers'), 'L2 must outlive L1 or the fix buys nothing');
});

// ── Awaited invalidation (what makes a long L2 TTL safe) ─────────────────

test('PIN: both write paths AWAIT the cache bust — a floating Redis DELETE can be lost', () => {
  // On Vercel the instance can freeze the instant the response is sent. An
  // un-awaited cacheDel may never land, and the next reader then pulls the
  // STALE shared value and re-stamps its own L1 with a fresh timestamp — the
  // stale rancher survives a whole TTL. Survivable at 10s, not at 60s.
  const awaited = src.match(/await invalidateAirtableCache\(tableName\)/g) || [];
  assert.equal(awaited.length, 2, 'createRecord and updateRecord must each await the bust');
  assert.doesNotMatch(
    src,
    /if \(_cacheKey\(tableName\)\) invalidateAirtableCache\(tableName\);/,
    'no fire-and-forget invalidation may remain on a write path',
  );
  assert.match(src, /export function invalidateAirtableCache\(tableName\?: string\): Promise<void>/);
});

// ── Jittered, deadline-bounded backoff ───────────────────────────────────

test('PIN: withRateLimitRetry delegates to the jittered/deadline-bounded loop', () => {
  assert.match(src, /import \{ retryWithJitteredBackoff \} from '\.\/airtableBackoff'/);
  const idx = src.indexOf('async function withRateLimitRetry');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n}\n', idx));
  assert.match(body, /retryWithJitteredBackoff\(/);
  assert.match(body, /isRetryable: isAirtableRateLimitError/);
});

test('PIN: the old deterministic 1→2→4→8→16→32s ladder is gone', () => {
  assert.doesNotMatch(src, /const maxWait = 32000/, 'the 32s sleep ceiling must not come back');
  assert.doesNotMatch(src, /delay \*= 2/, 'the un-jittered doubling must not come back');
});

// ── The rate-limit classifier (now exported, so pin its edges) ───────────

test('a hung connection is NOT classified as a rate limit — it must propagate, never be slept on', () => {
  assert.equal(isAirtableRateLimitError(new AirtableTimeoutError('Ranchers', 10_000)), false);
});

test('429s are classified from statusCode, message, and wrapped message alike', () => {
  assert.equal(isAirtableRateLimitError({ statusCode: 429 }), true);
  assert.equal(isAirtableRateLimitError(new Error('Request failed with 429')), true);
  assert.equal(isAirtableRateLimitError(new Error('Rate Limit exceeded')), true);
  assert.equal(isAirtableRateLimitError({ error: { message: 'RATE LIMIT' } }), true);
  assert.equal(isAirtableRateLimitError(new Error('Unknown field name: "X"')), false);
});
