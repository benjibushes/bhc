// lib/stateWaitlist.ts — per-state waitlist counts for the farmers-market
// honest-empty fallback (local-first /shop, 2026-07-15).
//
// THE HONESTY RULE this serves: a state with no local supply must never show
// an empty market pretending otherwise — it degrades to "no ranch near you
// yet — {N} {State} families are waiting; join the list". The N here is the
// same truth the /half-a-cow/[state] pages publish: a count of Consumers
// rows whose {State} normalizes to the code. READ-ONLY, aggregate-only — no
// PII leaves this module, only { 'TX': 253, ... }.
//
// FAILURE CONTRACT (mirrors lib/socialProof): null = unknown (Airtable
// unreachable/timed out) → callers render the NEUTRAL copy with no numbers.
// A failed fetch must never surface as a zero-claim.
//
// Caching: 5-min in-process TTL + stale-if-error, same layering as
// lib/socialProof (Consumers isn't in the airtable.ts cache allowlist, so
// this lib-level cache is what keeps /shop's ISR renders from full-scanning
// Consumers every 10 seconds).

import { getAllRecords, TABLES, withTimeout, resolveAirtableTimeoutMs } from './airtable';
import { normalizeState } from './states';

/**
 * Pure aggregation (exported for tests): count rows per normalized state
 * code. 'Texas' and 'TX' both count as TX; junk/blank states are dropped —
 * never invented into a bucket.
 */
export function countWaitlistByState(
  rows: Array<Record<string, any>>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const st = normalizeState(row?.['State']);
    if (!st) continue;
    counts[st] = (counts[st] || 0) + 1;
  }
  return counts;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache: { ts: number; counts: Record<string, number> } | null = null;

/**
 * Waitlist count per state code, or null when the truth is unavailable.
 * Field-projected single scan (State only), timeout-fenced so a stalled
 * Airtable read can never hang an ISR render or a Vercel build.
 */
export async function getWaitlistCountsByState(): Promise<Record<string, number> | null> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.counts;
  try {
    const rows = (await withTimeout(
      getAllRecords(TABLES.CONSUMERS, undefined, { fields: ['State'] }),
      resolveAirtableTimeoutMs(),
      'stateWaitlist consumers scan',
    )) as Array<Record<string, any>>;
    const counts = countWaitlistByState(rows);
    _cache = { ts: Date.now(), counts };
    return counts;
  } catch (err) {
    console.error('[stateWaitlist] fetch failed:', err);
    // Stale-if-error: yesterday's real count beats claiming nothing.
    return _cache ? _cache.counts : null;
  }
}
