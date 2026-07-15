// GET /api/social-proof
//
// Public, aggregate-only social proof for client-rendered surfaces (the
// deposit checkout's ProofStripClient). Counts + GMV label + a
// "half cow — TX, jul 2026" latest-win label — never a buyer name, never PII.
//
// force-dynamic (NOT build-time ISR — this route must never fetch Airtable
// during `next build`); freshness is layered instead:
//   L1: lib/socialProof 5-min in-process cache (per warm lambda)
//   CDN: s-maxage=900 + stale-while-revalidate so Vercel's edge serves most
//        hits without invoking the function at all.
//
// Failure contract: on any Airtable failure the payload is { deals: 0 } and
// the client renders NOTHING. Never an error status — a proof endpoint must
// not create console noise on a checkout page.

import { NextResponse } from 'next/server';
import { getSocialProofStats, getWeeklySocialProofStats } from '@/lib/socialProof';

export const dynamic = 'force-dynamic';

const CACHE_HEADERS = {
  'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600',
};

export async function GET() {
  const stats = await getSocialProofStats();
  if (!stats || stats.deals <= 0) {
    return NextResponse.json({ deals: 0 }, { headers: CACHE_HEADERS });
  }
  // Network pulse (2026-07-15): trailing-7-day slice from the SAME cached
  // rows (getWeeklySocialProofStats never issues a second Airtable query).
  // weeklyDeals: 0 is an honest zero-week — clients fall back to all-time.
  const weekly = await getWeeklySocialProofStats();
  return NextResponse.json(
    {
      deals: stats.deals,
      gmvLabel: stats.gmvLabel,
      latestWinLabel: stats.latestWinLabel,
      weeklyDeals: weekly?.deals ?? 0,
      weeklyGmvLabel: weekly?.gmvLabel ?? '',
    },
    { headers: CACHE_HEADERS },
  );
}
