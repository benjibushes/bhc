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
import { getSocialProofStats } from '@/lib/socialProof';

export const dynamic = 'force-dynamic';

const CACHE_HEADERS = {
  'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600',
};

export async function GET() {
  const stats = await getSocialProofStats();
  if (!stats || stats.deals <= 0) {
    return NextResponse.json({ deals: 0 }, { headers: CACHE_HEADERS });
  }
  return NextResponse.json(
    {
      deals: stats.deals,
      gmvLabel: stats.gmvLabel,
      latestWinLabel: stats.latestWinLabel,
    },
    { headers: CACHE_HEADERS },
  );
}
