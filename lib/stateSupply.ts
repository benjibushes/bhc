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
// COUNTING CRITERIA — deliberately IDENTICAL to the shared discovery formula
// (lib/airtable stateDiscoveryRanchersFormula) that /access/[state] and
// /half-a-cow/[state] send to Airtable: a ranch counts for its primary
// {State} when Public Map Hidden is not set, Verification Status !=
// "Removed", its Active Status is not parked (Paused / Non-Compliant — see
// PARKED_ACTIVE_STATUSES below), and it is page-live — {Page Live} for
// onboarded ranchers, the `Broker Self Serve` opt-in for represented ones
// (Wave A, 2026-08-17; a token-only broker ranch stays invisible). If you
// change one, change both.
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
import { isBrokerRancher, isBrokerSelfServe } from './brokerRail';

/**
 * JS mirror of lib/airtable PARKED_STATUS_EXCLUSION_FORMULA. Declared here
 * rather than imported as a parsed formula string so the two stay readable
 * side by side; lib/brokerDiscoverySurfaces.test.ts pins the formula half and
 * lib/stateSupply.test.ts pins this one.
 */
const PARKED_ACTIVE_STATUSES = new Set(['Paused', 'Non-Compliant']);

/** Active Status reads as a plain string or a `{ name }` single-select cell. */
function readActiveStatus(row: Record<string, any>): string {
  const v = row?.['Active Status'];
  if (v == null) return '';
  return typeof v === 'object' && 'name' in v ? String((v as any).name ?? '') : String(v);
}

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
    if (row?.['Public Map Hidden']) continue;
    if (String(row?.['Verification Status'] || '') === 'Removed') continue;
    // PARKED (2026-08-18 audit, P1-2): mirrors the JS half of
    // PARKED_STATUS_EXCLUSION_FORMULA. A blank Active Status is NOT parked —
    // that is the broker-rail signup state and it passes, exactly as the two
    // `!=` checks do in Airtable. Without this, /shop's empty-market fallback
    // went back to contradicting /half-a-cow the moment a ranch was paused.
    if (PARKED_ACTIVE_STATUSES.has(readActiveStatus(row))) continue;
    if (isBrokerRancher(row)) {
      // BROKER RAIL (Wave A, 2026-08-17): a SELF-SERVE represented ranch has
      // a real public page (the #617 slug carve-out) and is routable supply,
      // so it counts — page-live BY DEFINITION of the opt-in ({Page Live} is
      // unset; represented ranchers never ran the wizard that sets it). A
      // TOKEN-ONLY broker ranch has no listing a visitor can reach, so
      // counting it would advertise depth no surface can show — invisible,
      // even with a stray Page Live tick. Mirrors {Broker Self Serve} = 1 in
      // the shared Airtable formula (blank = opted out, fail closed).
      if (!isBrokerSelfServe(row)) continue;
    } else if (!row?.['Page Live']) {
      continue;
    }
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
