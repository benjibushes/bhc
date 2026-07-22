// lib/sharedCache.ts
//
// Shared L2 cache on Upstash Redis for the hot Airtable full-table reads and
// the admin-config read. Scale-ladder item #2: the single Airtable base is
// capped at 5 req/s. Each Vercel lambda used to keep its OWN in-process cache
// (lib/airtable.ts _cache, lib/adminConfig.ts _cfgCache), so under ad-driven
// serverless fan-out N cold instances all re-read Airtable. This module puts a
// SHARED cache in front of Airtable so those instances share ONE read.
//
// Layering (per caller):
//   L1  in-process module cache  — kept as-is in each caller (2-3s..60s TTL).
//        Absorbs a burst served by a single warm lambda without touching Redis.
//   L2  Redis (this module)      — shared across all instances (10s..60s TTL).
//        A cold instance with an empty L1 pulls the shared value instead of
//        hitting Airtable.
//   L3  Airtable (source)        — read only on an L1+L2 miss, then written to
//        both L2 (here) and L1 (caller).
//
// FAIL-OPEN + FAIL-SAFE — this module NEVER throws and NEVER breaks a read:
//   - Env unset (local/dev/test): getRedis() returns null → every op is a
//     no-op. cacheGet → MISS, cacheSet/cacheDel → no-op. Callers behave
//     EXACTLY as before this module existed (pure in-process). Keeps local dev
//     and the test suite (which run with NO Upstash env) byte-for-byte the same.
//   - Redis down / network error / malformed value: every op is wrapped in
//     try/catch and degrades to MISS / no-op with a console.warn. A Redis blip
//     can never surface as an Airtable read failure.

import { Redis } from '@upstash/redis';

// Reuse the exact lazy-init pattern from lib/rateLimit.ts / lib/founderNumber.ts.
// Missing env does NOT crash at import — we return null and callers fall back
// to pure in-process behavior.
let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  // cache: 'default' — ISR regression fix (bulletproof walkthrough 2026-07-15).
  // @upstash/redis defaults its fetch() to cache: 'no-store'. This L2 sits
  // inside getAllRecords for allowlisted tables (Ranchers, Rancher Products…),
  // which statically-rendered pages read (/wins reads Ranchers, /ranchers/
  // [slug] reads Rancher Products via loadProductsForRancher). In Next 16 an
  // explicit no-store fetch during an ISR revalidation render throws "Page
  // changed from static to dynamic at runtime, reason: no-store fetch
  // https://…upstash.io/pipeline" (72+ prod occurrences) — the revalidation
  // fails and users got the bare /500 ENOENT fallback. An explicit 'default'
  // is treated by Next's patched fetch as "no cache config" (patch-fetch.js:
  // autoNoCache — POSTs are never stored in the Data Cache, and autoNoCache
  // is documented as NOT switching an ISR render to dynamic), so Redis reads
  // execute live everywhere without dynamic bailout. Keeps every SEO page
  // static AND keeps the L2 cache for API-route fan-out.
  _redis = new Redis({ url, token, cache: 'default' });
  return _redis;
}

// Minimal structural type for the Redis ops we use. Lets tests inject a fake
// (or throwing) client without a live Upstash — see sharedCache.test.ts.
export interface RedisLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, opts?: { ex?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

// ── Pure serialization helpers (unit-tested) ─────────────────────────────
// @upstash/redis auto-JSON-parses values it recognizes as JSON on read and
// auto-stringifies objects on write. To keep the contract explicit and
// tolerant of BOTH behaviors (a string we stored, or an object Upstash already
// parsed), we always STORE a JSON string and, on read, accept either a string
// (parse it) or an already-parsed object/array (pass through). This makes the
// (de)serialization deterministic and independent of client-version quirks.

/** Serialize a value for storage. Always returns a JSON string. */
export function serialize(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Parse a value read back from Redis. Accepts a JSON string OR an
 * already-parsed object/array (Upstash may auto-parse). Returns undefined on
 * null/undefined (a genuine MISS) or on malformed JSON (treated as a MISS so
 * the caller falls through to source — never throws).
 */
export function deserialize<T>(raw: unknown): T | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }
  // Already an object/array/number/boolean (Upstash auto-parsed it).
  return raw as T;
}

// ── L2 operations (all fail-open, all internal-client-injectable for tests) ──

/**
 * Read `key` from the shared cache.
 * Returns the deserialized value on a hit, or undefined on:
 *   - Redis not configured (env unset)  → MISS (no-op)
 *   - genuine key miss                  → MISS
 *   - malformed stored value            → MISS
 *   - any Redis error                   → MISS (fail-open, console.warn)
 * NEVER throws.
 */
export async function cacheGet<T>(key: string, client?: RedisLike): Promise<T | undefined> {
  const redis = (client ?? getRedis()) as RedisLike | null;
  if (!redis) return undefined; // env unset → behave as pure in-process
  try {
    const raw = await redis.get(key);
    return deserialize<T>(raw);
  } catch (e: any) {
    console.warn(`[sharedCache] get(${key}) failed, treating as miss:`, e?.message);
    return undefined;
  }
}

/**
 * Write `key` = `value` with a TTL of `ttlMs` (converted to whole seconds for
 * Redis EX). No-op when Redis is unconfigured. Swallows all errors (fail-safe):
 * a failed write just means the next reader re-reads source. NEVER throws.
 */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlMs: number,
  client?: RedisLike,
): Promise<void> {
  const redis = (client ?? getRedis()) as RedisLike | null;
  if (!redis) return;
  try {
    // Redis EX is in whole seconds; floor(ms/1000) and guard a >=1s minimum so
    // a sub-second TTL doesn't collapse to EX 0 (which Upstash rejects).
    const ex = Math.max(1, Math.floor(ttlMs / 1000));
    await redis.set(key, serialize(value), { ex });
  } catch (e: any) {
    console.warn(`[sharedCache] set(${key}) failed, ignoring:`, e?.message);
  }
}

/**
 * Delete `key` from the shared cache (invalidation). No-op when unconfigured.
 * Swallows all errors: a failed delete means the shared value lingers until its
 * TTL — bounded staleness, never a crash. NEVER throws.
 */
export async function cacheDel(key: string, client?: RedisLike): Promise<void> {
  const redis = (client ?? getRedis()) as RedisLike | null;
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (e: any) {
    console.warn(`[sharedCache] del(${key}) failed, ignoring:`, e?.message);
  }
}

/** True when Upstash env is configured (L2 is active). For diagnostics/tests. */
export function isSharedCacheEnabled(): boolean {
  return getRedis() !== null;
}

// ── Shared counter (cross-instance rate limiting) ────────────────────────
// Scale audit 2026-07-22: the Resend token bucket in lib/email.ts lives in
// module state — per lambda instance — so concurrent crons (demand-router +
// send-scheduled + qualified-no-action) could aggregate past Resend's 10/s.
// A shared INCR on a per-second key makes the bucket global.

// Minimal structural type for the counter ops. Same injectable-fake pattern
// as RedisLike above — see sharedCache.test.ts.
export interface RedisCounterLike {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/**
 * Atomically increment `key`, setting a TTL of `ttlSeconds` on first
 * increment so the counter self-expires. Returns the post-increment count,
 * or undefined when:
 *   - Redis not configured (env unset) → callers fall back to per-process
 *   - any Redis error                  → fail-open, console.warn
 * NEVER throws.
 */
export async function cacheIncrWithTtl(
  key: string,
  ttlSeconds: number,
  client?: RedisCounterLike,
): Promise<number | undefined> {
  const redis = (client ?? getRedis()) as RedisCounterLike | null;
  if (!redis) return undefined;
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, Math.max(1, ttlSeconds));
    return n;
  } catch (e: any) {
    console.warn(`[sharedCache] incr(${key}) failed, falling back to per-process:`, e?.message);
    return undefined;
  }
}
