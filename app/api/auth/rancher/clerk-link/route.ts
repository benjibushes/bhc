// Auth Phase 2 — manual Clerk ↔ Ranchers row link endpoint.
//
// `resolveRancherSession` already auto-links the Ranchers row on first
// Clerk login. This endpoint is a cheap manual fallback for QA / ops
// in case the auto-link path was bypassed (e.g. rancher signed up via
// Clerk but never hit a rancher-gated endpoint).
//
// Auth: requires an active Clerk rancher session. 503 when the feature
// flag is off (kept consistent with how /api/auth/member/clerk-link
// gates Phase 1 — clear signal the feature is intentionally disabled
// rather than a server error).

import { NextResponse } from 'next/server';
import {
  resolveRancherSession,
  CLERK_RANCHER_ENABLED,
} from '@/lib/rancherAuth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!CLERK_RANCHER_ENABLED) {
    return NextResponse.json(
      { error: 'Clerk rancher auth is disabled' },
      { status: 503 },
    );
  }
  // resolveRancherSession auto-links the Ranchers row on first hit.
  // By calling it here we force the link to happen for the active
  // Clerk user (idempotent — no-op if the link already exists).
  const session = await resolveRancherSession(request);
  if (!session || session.source !== 'clerk') {
    return NextResponse.json(
      { error: 'No active Clerk rancher session' },
      { status: 401 },
    );
  }
  return NextResponse.json({
    ok: true,
    rancherId: session.rancherId,
    email: session.email,
    ranchName: session.ranchName,
  });
}
