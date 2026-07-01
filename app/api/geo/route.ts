// app/api/geo/route.ts
//
// Best-effort US-state hint for the buyer funnel's state prefill. BuyerFunnel
// fetches this on mount (previously a 404 on every /access load — pure latency
// + log noise). Vercel injects geo headers on every request; for US visitors
// `x-vercel-ip-country-region` is the 2-letter state code (CA, TX, …). Never
// authoritative — the funnel's state <select> is always the floor, and this
// only pre-selects when the buyer hasn't picked yet.

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const country = (req.headers.get('x-vercel-ip-country') || '').toUpperCase();
  const region = (req.headers.get('x-vercel-ip-country-region') || '').toUpperCase();
  const state = country === 'US' && /^[A-Z]{2}$/.test(region) ? region : '';
  return NextResponse.json({ state }, { headers: { 'Cache-Control': 'no-store' } });
}
