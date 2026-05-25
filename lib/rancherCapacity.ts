/**
 * Rancher capacity field aliasing.
 *
 * THE BUG WE'RE PREVENTING: The Airtable schema has a field named
 * `Max Active Referalls` (typo: missing one L). Code reads this typo'd name
 * in 20+ places. If anyone "fixes" the spelling in Airtable to
 * `Max Active Referrals`, every code reader returns `undefined` and
 * silently falls back to a default of 5 — meaning every rancher's capacity
 * silently collapses to 5 the moment someone tries to clean up the schema.
 *
 * This helper reads from BOTH spellings. Whichever has a non-null value wins.
 * Writes still go through the existing typo'd field name (preserving compat),
 * but reads are defended.
 *
 * ATOMIC CAPACITY COUNTER (Round 6 race fix):
 * The legacy capacity bump in matching/suggest was check-then-write:
 *   1. read `Current Active Referrals` from Airtable
 *   2. compare to cap
 *   3. write `currentRefs + 1` back
 * Two concurrent buyers routed to the same rancher could both pass the
 * gate + both write N+1, overflowing capacity by 1-2 under burst.
 *
 * The fix mirrors the proven pattern in `lib/founderNumber.ts`:
 * Upstash Redis INCR/DECR is atomic + distributed. Bootstrap from
 * Airtable on first call so we don't restart at 1. Mirror writes back
 * to Airtable post-INCR/DECR so dashboards stay accurate (eventual
 * consistency for reads, atomic for writes).
 *
 * Fail-open: missing Redis env OR INCR throw → callers fall back to
 * legacy Airtable count-then-write. console.error so failures surface.
 */

import { Redis } from '@upstash/redis';
import { getRecordById, updateRecord, TABLES } from './airtable';

const DEFAULT_MAX = 5;

export function getMaxActiveReferrals(rancher: any): number {
  if (!rancher) return DEFAULT_MAX;
  // Try corrected spelling first (futures-proof). Fall back to typo. Default 5.
  const correct = rancher['Max Active Referrals'];
  if (correct !== undefined && correct !== null && correct !== '') return Number(correct);
  // eslint-disable-next-line dot-notation
  const typo = rancher['Max Active Referalls'];
  if (typo !== undefined && typo !== null && typo !== '') return Number(typo);
  return DEFAULT_MAX;
}

/**
 * Returns the field name to use when WRITING to Airtable. Currently still
 * the typo'd name, since the schema field is `Max Active Referalls`. If/when
 * the schema is corrected, change this constant in one place.
 */
export const MAX_ACTIVE_REFERRALS_FIELD = 'Max Active Referalls';

// ── Atomic capacity counter via Upstash Redis ─────────────────────────────

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

function capacityKey(rancherId: string): string {
  return `bhc:rancher-capacity:${rancherId}`;
}

/**
 * Atomically increment the rancher's Current Active Referrals counter.
 * Race-safe under burst — two concurrent buyers routed to the same rancher
 * cannot both observe + write the same N+1 value.
 *
 * First-ever INCR for a rancher bootstraps the counter from Airtable so we
 * pick up where the live data left off (manual admin tweaks, legacy fills).
 *
 * Returns the new counter value (after increment). On any Redis failure
 * falls back to the legacy Airtable read+1 path with a console.error so
 * the race surfaces in logs but the route still completes.
 */
export async function incrementCapacity(rancherId: string): Promise<number> {
  const redis = getRedis();
  if (!redis) {
    return await legacyIncrement(rancherId);
  }
  try {
    const key = capacityKey(rancherId);
    const n = await redis.incr(key);
    if (n === 1) {
      // First-ever incr — bootstrap from Airtable so a fresh Redis key
      // doesn't reset a rancher who's already at e.g. 7/10 back to 1.
      try {
        const live = await currentAirtableCount(rancherId);
        if (live >= 1) {
          const bootstrapped = live + 1;
          await redis.set(key, bootstrapped);
          return bootstrapped;
        }
      } catch {
        // Bootstrap read failed — honor n=1. Worst case the counter under-
        // reports for one cycle; SyncCapacityToAirtable will rewrite the
        // mirror field on the next decrement.
      }
    }
    return n;
  } catch (e: any) {
    console.error('[incrementCapacity] Redis INCR failed, falling back to legacy:', e?.message);
    return await legacyIncrement(rancherId);
  }
}

/**
 * Atomically decrement the rancher's Current Active Referrals counter.
 * Clamps at 0 so a stray double-decrement never produces a negative slot
 * count (which would silently grant the rancher unbounded capacity).
 *
 * Returns the new counter value (after decrement). On any Redis failure
 * falls back to the legacy Airtable read-1 path.
 */
export async function decrementCapacity(rancherId: string): Promise<number> {
  const redis = getRedis();
  if (!redis) {
    return await legacyDecrement(rancherId);
  }
  try {
    const key = capacityKey(rancherId);
    // If the key doesn't exist yet (first operation on this rancher is a
    // decrement, e.g. a Closed Lost on a referral that predates this fix),
    // bootstrap from Airtable so we start at the right base before DECR.
    const exists = await redis.exists(key);
    if (!exists) {
      const live = await currentAirtableCount(rancherId);
      await redis.set(key, live);
    }
    const n = await redis.decr(key);
    if (n < 0) {
      // Clamp at 0 — also rewrite Redis so we don't drift negative.
      await redis.set(key, 0);
      return 0;
    }
    return n;
  } catch (e: any) {
    console.error('[decrementCapacity] Redis DECR failed, falling back to legacy:', e?.message);
    return await legacyDecrement(rancherId);
  }
}

/**
 * Mirror the post-INCR/DECR counter value into Airtable's
 * Current Active Referrals field. Called AFTER a successful atomic op so
 * dashboards + downstream cron reads see the new value. Eventual-
 * consistency for reads, but writes themselves stay atomic via Redis.
 *
 * Non-fatal: a missed mirror leaves Redis as the source of truth.
 * console.error surfaces drift.
 */
export async function syncCapacityToAirtable(rancherId: string, newValue: number): Promise<void> {
  try {
    await updateRecord(TABLES.RANCHERS, rancherId, {
      'Current Active Referrals': Math.max(0, newValue),
    });
  } catch (e: any) {
    console.error('[syncCapacityToAirtable] Airtable mirror write failed:', e?.message);
  }
}

async function currentAirtableCount(rancherId: string): Promise<number> {
  const rec: any = await getRecordById(TABLES.RANCHERS, rancherId);
  return Number(rec?.['Current Active Referrals'] || 0);
}

async function legacyIncrement(rancherId: string): Promise<number> {
  try {
    const live = await currentAirtableCount(rancherId);
    const next = live + 1;
    await updateRecord(TABLES.RANCHERS, rancherId, {
      'Current Active Referrals': next,
    });
    return next;
  } catch (e: any) {
    console.error('[incrementCapacity] legacy increment also failed:', e?.message);
    // Last-ditch: return 0 so the caller treats it as "unknown" instead of
    // crashing. Mismatch will self-heal once Redis env is restored.
    return 0;
  }
}

async function legacyDecrement(rancherId: string): Promise<number> {
  try {
    const live = await currentAirtableCount(rancherId);
    const next = Math.max(0, live - 1);
    await updateRecord(TABLES.RANCHERS, rancherId, {
      'Current Active Referrals': next,
    });
    return next;
  } catch (e: any) {
    console.error('[decrementCapacity] legacy decrement also failed:', e?.message);
    return 0;
  }
}
