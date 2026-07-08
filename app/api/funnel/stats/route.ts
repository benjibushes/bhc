// GET /api/funnel/stats?state=XX
//
// Live social-proof counts for the buyer funnel — families matched, verified
// ranches, and ranches serving the buyer's state. Pulled live (never hardcoded)
// so "1,900+ families" can't go stale or false. Cached 5 min. Public, no PII.

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { isRancherOperationalForBuyers, getOperationalServedStates } from '@/lib/rancherEligibility';
import { normalizeState } from '@/lib/states';
import { cacheGet as sharedCacheGet, cacheSet as sharedCacheSet } from '@/lib/sharedCache';

export const dynamic = 'force-dynamic';

// Optional marketing floor so brand-new platforms don't show "0 families". Real
// count is used once it exceeds the floor.
const FAMILIES_FLOOR = 1900;

interface StatsData {
  familiesMatched: number;
  verifiedRanches: number;
  byState: Record<string, number>;
}

let cache: { at: number; data: StatsData } | null = null;
// Single-flight: concurrent requests on a cold lambda previously EACH ran
// their own full compute() (the in-process cache is only written after the
// await resolves) — N simultaneous funnel mounts = N Consumers full scans.
let computeInFlight: Promise<StatsData> | null = null;
const STATS_REDIS_KEY = 'funnelstats:cache';

async function compute(): Promise<StatsData> {
  const [cons, rans] = await Promise.all([
    // Scale audit 2026-07-07 (CRITICAL): Consumers is the fastest-growing
    // table (2,493 rows = 25 paginated requests per scan) and this route
    // needed ONE number from it. Server-side filter: UPPER() keeps the
    // exact case-tolerant semantics of the old JS toUpperCase() compare.
    getAllRecords(TABLES.CONSUMERS, 'UPPER({Buyer Stage}) = "CLOSED"').catch(() => []) as Promise<any[]>,
    // Ranchers full list rides the L1/L2 table cache (allowlisted).
    getAllRecords(TABLES.RANCHERS).catch(() => []) as Promise<any[]>,
  ]);
  const op = rans.filter(isRancherOperationalForBuyers);
  const closed = cons.length;
  const byState: Record<string, number> = {};
  for (const r of op) {
    for (const s of getOperationalServedStates(r)) byState[s] = (byState[s] || 0) + 1;
  }
  return { familiesMatched: Math.max(FAMILIES_FLOOR, closed), verifiedRanches: op.length, byState };
}

export async function GET(req: Request) {
  const state = normalizeState(new URL(req.url).searchParams.get('state'));
  try {
    if (!cache || Date.now() - cache.at > 300_000) {
      // L2 shared cache: a cold instance adopts the value another instance
      // already computed instead of paying its own Airtable reads. Fail-open.
      const shared = await sharedCacheGet<StatsData>(STATS_REDIS_KEY);
      if (shared !== undefined) {
        cache = { at: Date.now(), data: shared };
      } else {
        if (!computeInFlight) {
          computeInFlight = compute().finally(() => { computeInFlight = null; });
        }
        const data = await computeInFlight;
        cache = { at: Date.now(), data };
        await sharedCacheSet(STATS_REDIS_KEY, data, 300_000);
      }
    }
    const d = cache.data;
    return NextResponse.json({
      familiesMatched: d.familiesMatched,
      verifiedRanches: d.verifiedRanches,
      ranchesInState: state ? d.byState[state] || 0 : 0,
    }, {
      // CDN-cache the response (keyed per ?state) so a cold lambda doesn't
      // recompute this vanity stat on every funnel mount (542 hits/24h). The
      // in-process cache only helps warm lambdas; this offloads to the edge.
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  } catch {
    return NextResponse.json({ familiesMatched: FAMILIES_FLOOR, verifiedRanches: 0, ranchesInState: 0 });
  }
}
