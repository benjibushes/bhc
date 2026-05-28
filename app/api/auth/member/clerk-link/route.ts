// Auth Phase 1 — manual Clerk ↔ Consumers row link endpoint.
//
// `resolveBuyerSession` already auto-links the Consumers row on first
// Clerk login. This endpoint is a cheap manual fallback for QA / ops
// in case the auto-link path was bypassed (e.g. user signed up via
// Clerk but never hit a buyer-gated endpoint).
//
// Auth: requires an active Clerk buyer session. 503 when the feature
// flag is off (kept consistent with how /api/checkout/deposit gates
// Stripe Connect — clear signal the feature is intentionally disabled
// rather than a server error).

import { NextResponse } from 'next/server';
import { resolveBuyerSession, CLERK_BUYER_ENABLED } from '@/lib/buyerAuth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!CLERK_BUYER_ENABLED) {
    return NextResponse.json(
      { error: 'Clerk buyer auth is disabled' },
      { status: 503 },
    );
  }
  // resolveBuyerSession auto-links the Consumers row on first hit. By
  // calling it here we force the link to happen for the active Clerk
  // user (idempotent — no-op if the link already exists).
  const session = await resolveBuyerSession(request);
  if (!session || session.source !== 'clerk') {
    return NextResponse.json(
      { error: 'No active Clerk buyer session' },
      { status: 401 },
    );
  }
  return NextResponse.json({
    ok: true,
    consumerId: session.consumerId,
    email: session.email,
  });
}
