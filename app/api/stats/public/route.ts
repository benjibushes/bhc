import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export const maxDuration = 60;

// Public stats — drives the homepage LiveCounter + various marketing
// counters. We expose BOTH a raw rancher count and a verified-only count
// because the public-facing copy should NEVER claim coverage we don't have
// (BHC.md anti-pattern #2). Old callers reading `rancherCount` continue
// to work; new callers prefer `verifiedRancherCount` for honest claims.
//
// Buyer count is also split: total members vs Beef Buyer segment, so copy
// can say "X beef buyers" instead of conflating beef + community signups.

type CachedStats = {
  rancherCount: number;
  verifiedRancherCount: number;
  buyerCount: number;
  beefBuyerCount: number;
  stateCount: number;
  verifiedStateCount: number;
  timestamp: number;
};

let cachedStats: CachedStats | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function GET() {
  try {
    if (cachedStats && Date.now() - cachedStats.timestamp < CACHE_TTL) {
      const { timestamp: _t, ...data } = cachedStats;
      return NextResponse.json(data, {
        headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
      });
    }

    const [ranchers, consumers] = await Promise.all([
      getAllRecords(TABLES.RANCHERS),
      getAllRecords(TABLES.CONSUMERS),
    ]);

    const allRanchers = ranchers as any[];
    const verifiedRanchers = allRanchers.filter(
      (r) => r['Verification Status'] === 'Verified'
    );

    const rancherCount = allRanchers.length;
    const verifiedRancherCount = verifiedRanchers.length;

    const allConsumers = consumers as any[];
    const buyerCount = allConsumers.length;
    const beefBuyerCount = allConsumers.filter(
      (c) => c['Segment'] === 'Beef Buyer'
    ).length;

    const stateCount = new Set(
      allRanchers
        .map((r) => (r['State'] || '').toString().trim().toUpperCase())
        .filter(Boolean)
    ).size;
    const verifiedStateCount = new Set(
      verifiedRanchers
        .map((r) => (r['State'] || '').toString().trim().toUpperCase())
        .filter(Boolean)
    ).size;

    cachedStats = {
      rancherCount,
      verifiedRancherCount,
      buyerCount,
      beefBuyerCount,
      stateCount,
      verifiedStateCount,
      timestamp: Date.now(),
    };

    const { timestamp: _t, ...payload } = cachedStats;
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  } catch (error: any) {
    console.error('Error fetching public stats:', error);
    return NextResponse.json(
      {
        rancherCount: 0,
        verifiedRancherCount: 0,
        buyerCount: 0,
        beefBuyerCount: 0,
        stateCount: 0,
        verifiedStateCount: 0,
      },
      { status: 500 }
    );
  }
}
