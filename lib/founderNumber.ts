import { getAllRecords, escapeAirtableValue, TABLES } from './airtable';
import { Redis } from '@upstash/redis';

// Atomic per-tier Founder Number counter.
//
// Prior implementation queried Airtable for current count + 1 in the Stripe
// webhook. Race-prone: two webhooks firing within ~2s for the same tier
// both see N rows, both assign Number N+1, two Founders collide on the
// same display number.
//
// This module uses Upstash Redis INCR — atomic, distributed, race-safe.
// First-ever call for a tier bootstraps the counter from Airtable's current
// count so the sequence picks up where the live data left off.
//
// Idempotency note: the Stripe webhook already short-circuits on duplicate
// Stripe Session ID before reaching here, so retries can't double-incr for
// the same checkout. This counter is for distinct concurrent checkouts.
//
// Fail-open: if Redis isn't configured (UPSTASH_REDIS_REST_URL missing) OR
// the INCR throws, we fall back to the legacy Airtable-count-based path
// with a console.error. Won't crash a paid checkout.

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

function counterKey(tier: string): string {
  return `bhc:founder-number:${tier.toLowerCase().replace(/\s+/g, '-')}`;
}

/**
 * Atomically assign the next Founder Number for `tier`. Race-safe.
 *
 * Returns the assigned number. On any error path falls back to legacy
 * count-then-assign (race-prone but functional).
 */
export async function assignFounderNumber(tier: string): Promise<number> {
  const redis = getRedis();

  if (!redis) {
    return await legacyAssign(tier);
  }

  try {
    const key = counterKey(tier);
    const n = await redis.incr(key);

    // First-ever incr for this tier — bootstrap counter from Airtable so
    // we don't restart at 1 if rows already exist (manual admin comps,
    // legacy backfills, etc).
    if (n === 1) {
      try {
        const realCount = await currentAirtableCount(tier);
        if (realCount >= 1) {
          // Bump counter to where it should be. SET is overwrite — race
          // window here is exactly one tier-first call. Subsequent calls
          // resolve fine via plain INCR.
          await redis.set(key, realCount + 1);
          return realCount + 1;
        }
      } catch {
        // Airtable bootstrap read failed; honor n=1.
      }
    }

    return n;
  } catch (e: any) {
    console.error('[assignFounderNumber] Redis INCR failed, falling back:', e?.message);
    return await legacyAssign(tier);
  }
}

async function currentAirtableCount(tier: string): Promise<number> {
  const rows = await getAllRecords(
    TABLES.CONSUMERS,
    `{Founder Tier} = "${escapeAirtableValue(tier)}"`,
  );
  return (rows as any[]).length;
}

async function legacyAssign(tier: string): Promise<number> {
  try {
    return (await currentAirtableCount(tier)) + 1;
  } catch (e: any) {
    console.error('[assignFounderNumber] legacy assign also failed:', e?.message);
    // Last-ditch: return 0 so the webhook write doesn't crash (caller
    // should handle 0 as "unknown number"). Better than throwing.
    return 0;
  }
}
