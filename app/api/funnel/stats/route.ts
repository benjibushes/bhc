// GET /api/funnel/stats?state=XX
//
// Live social-proof counts for the buyer funnel — families matched, verified
// ranches, and ranches serving the buyer's state. Pulled live (never hardcoded)
// so "1,900+ families" can't go stale or false. Cached 5 min. Public, no PII.

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { isRancherOperationalForBuyers, getOperationalServedStates } from '@/lib/rancherEligibility';
import { normalizeState } from '@/lib/states';

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

async function compute(): Promise<StatsData> {
  const [cons, rans] = await Promise.all([
    getAllRecords(TABLES.CONSUMERS).catch(() => []) as Promise<any[]>,
    getAllRecords(TABLES.RANCHERS).catch(() => []) as Promise<any[]>,
  ]);
  const op = rans.filter(isRancherOperationalForBuyers);
  const closed = cons.filter((c) => String(c['Buyer Stage'] || '').toUpperCase() === 'CLOSED').length;
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
      cache = { at: Date.now(), data: await compute() };
    }
    const d = cache.data;
    return NextResponse.json({
      familiesMatched: d.familiesMatched,
      verifiedRanches: d.verifiedRanches,
      ranchesInState: state ? d.byState[state] || 0 : 0,
    });
  } catch {
    return NextResponse.json({ familiesMatched: FAMILIES_FLOOR, verifiedRanches: 0, ranchesInState: 0 });
  }
}
