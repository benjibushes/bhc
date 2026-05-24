// GET /api/testimonials?limit=3 — returns recent Closed Won testimonials
// for the social-proof slot on client-rendered pages like /access.
//
// /start fetches getRecentTestimonials() directly server-side; this route
// exists so /access (which is 'use client' for the quiz form) can still
// render real testimonials without a heavy refactor.
//
// 5-min ISR cache + the helper's in-process cache mean this is cheap.
// Failures return { testimonials: [] } so the client falls back to
// hardcoded placeholder copy.

import { NextRequest, NextResponse } from 'next/server';
import { getRecentTestimonials } from '@/lib/testimonials';

export const runtime = 'nodejs';
export const revalidate = 300;

export async function GET(req: NextRequest) {
  const limitParam = req.nextUrl.searchParams.get('limit');
  const parsed = Number(limitParam);
  const limit = Number.isFinite(parsed) && parsed > 0 && parsed <= 10 ? Math.floor(parsed) : 3;

  try {
    const testimonials = await getRecentTestimonials(limit);
    return NextResponse.json(
      { testimonials },
      {
        headers: {
          // Edge / CDN cache 5 min, stale-while-revalidate 1h. Marketing
          // page testimonials don't need to be real-time.
          'Cache-Control': 's-maxage=300, stale-while-revalidate=3600',
        },
      }
    );
  } catch (e) {
    console.error('[/api/testimonials] failed:', e);
    return NextResponse.json({ testimonials: [] }, { status: 200 });
  }
}
