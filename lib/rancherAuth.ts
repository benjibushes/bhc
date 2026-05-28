// Rancher session resolver — legacy JWT path only.
//
// Reads the `bhc-rancher-auth` cookie (issued by magic-link verify +
// admin impersonate), verifies it, and returns a RancherSession the
// callers can hand off without branching on auth source.
//
// (Clerk wrappers used to live here behind CLERK_RANCHER_ENABLED — pulled
// 2026-05-27 after the Clerk domain reservation conflict made the path
// permanently unusable. A future TOTP / SSO swap will live next to this
// resolver, not replace it inline.)

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';

const BHC_RANCHER_COOKIE = 'bhc-rancher-auth';

export interface RancherSession {
  rancherId: string;
  email: string;
  name: string;
  ranchName: string;
  state: string;
  // Preserve admin impersonation surface so the dashboard can keep
  // rendering admin-only controls (e.g. "Revive Lead" on Closed Lost
  // referrals). Populated by /api/admin/ranchers/[id]/impersonate when
  // the legacy JWT is minted.
  impersonatedBy?: string | null;
}

/**
 * Resolve the rancher session for an incoming request.
 *
 * Reads the legacy bhc-rancher-auth JWT cookie. Returns null if the
 * cookie is missing, the JWT is invalid, or the claim type doesn't match.
 */
export async function resolveRancherSession(
  _request: Request,
): Promise<RancherSession | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(BHC_RANCHER_COOKIE);
  if (!cookie?.value) return null;
  let decoded: any;
  try {
    decoded = jwt.verify(cookie.value, JWT_SECRET);
  } catch {
    return null;
  }
  if (decoded.type !== 'rancher-session') return null;
  return {
    rancherId: String(decoded.rancherId || ''),
    email: String(decoded.email || ''),
    name: String(decoded.name || ''),
    ranchName: String(decoded.ranchName || ''),
    state: String(decoded.state || ''),
    impersonatedBy: decoded.impersonatedBy || null,
  };
}

/**
 * Wrapper for route handlers that need a rancher session.
 *
 * Returns:
 *   - `{ session }` on success
 *   - 401 NextResponse when no session resolves
 *
 * Usage:
 *   const r = await requireRancher(request);
 *   if (r instanceof NextResponse) return r;
 *   const { session } = r;
 */
export async function requireRancher(
  request: Request,
): Promise<{ session: RancherSession } | NextResponse> {
  const session = await resolveRancherSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return { session };
}
