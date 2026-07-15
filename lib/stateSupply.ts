// lib/stateSupply.ts — per-state LIVE share-ranch counts for cross-surface
// honesty (bulletproof walkthrough 2026-07-15).
//
// THE CONTRADICTION this kills: /shop's empty-market fallback told a CO buyer
// "no verified ranch goes live near you" while /half-a-cow/colorado said
// "2 verified ranches are live". The market fallback is now stand-scoped
// (no ranch STAND selling shipped boxes) and, when the state HAS live
// share-ranches, cross-links the buyer to /half-a-cow/[state] instead of
// implying a supply desert.
//
// COUNTING CRITERIA — deliberately IDENTICAL to /half-a-cow/[state]'s
// fetchStateCounts (the page whose claim we must agree with): a ranch counts
// for its primary {State} when Page Live is set, Public Map Hidden is not,
// and Verification Status != "Removed". If you change one, change both.
//
// FAILURE CONTRACT (mirrors lib/stateWaitlist): null = unknown (Airtable
// unreachable/timed out) → callers render nothing. A failed fetch must never
// invent or suppress supply.
//
// Cost: ONE unfiltered Ranchers read that rides the airtable.ts L1/L2 cache
// allowlist (unfiltered + unprojected on purpose — a projected read would
// bypass the table cache), then pure JS. 5-min in-process TTL +
// stale-if-error on top, same layering as stateWaitlist/socialProof.

import { getAllRecords, TABLES, withTimeout, resolveAirtableTimeoutMs } from './airtable';
import { normalizeState } from './states';

/**
 * Pure aggregation (exported for tests): live share-ranch count per
 * normalized primary-state code, same visibility filter as
 * /half-a-cow/[state]. 'Montana' and 'MT' both bucket to MT; blank/junk
 * states are dropped, never invented.
 */
export function countLiveShareRanchesByState(
  rows: Array<Record<string, any>>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (!row?.['Page Live']) continue;
    if (row?.['Public Map Hidden']) continue;
    if (String(row?.['Verification Status'] || '') === 'Removed') continue;
    const st = normalizeState(row?.['State']);
    if (!st) continue;
    counts[st] = (counts[st] || 0) + 1;
  }
  return counts;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache: { ts: number; counts: Record<string, number> } | null = null;

/**
 * Live share-ranch count per state code, or null when the truth is
 * unavailable. Timeout-fenced so a stalled Airtable read can never hang an
 * ISR render or a Vercel build.
 */
export async function getLiveShareRanchCountsByState(): Promise<Record<string, number> | null> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.counts;
  try {
    const rows = (await withTimeout(
      getAllRecords(TABLES.RANCHERS),
      resolveAirtableTimeoutMs(),
      'stateSupply ranchers scan',
    )) as Array<Record<string, any>>;
    const counts = countLiveShareRanchesByState(rows);
    _cache = { ts: Date.now(), counts };
    return counts;
  } catch (err) {
    console.error('[stateSupply] fetch failed:', err);
    // Stale-if-error: a 5-min-old real count beats claiming unknown.
    return _cache ? _cache.counts : null;
  }
}
