// Buyer session resolver — legacy JWT path only.
//
// Reads the `bhc-member-auth` cookie (issued by magic-link verify +
// warmup engage), verifies it, and returns a BuyerSession the callers
// can hand off without branching on auth source.
//
// (Clerk wrappers used to live here behind CLERK_BUYER_ENABLED — pulled
// 2026-05-27 after the Clerk domain reservation conflict made the path
// permanently unusable. A future TOTP / SSO swap will live next to this
// resolver, not replace it inline.)

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';

const BHC_MEMBER_COOKIE = 'bhc-member-auth';

export interface BuyerSession {
  consumerId: string;
  email: string;
  name: string;
  state: string;
}

/**
 * Resolve the buyer session for an incoming request.
 *
 * Reads the legacy bhc-member-auth JWT cookie. Returns null if the cookie
 * is missing, the JWT is invalid, or the claim type doesn't match.
 */
export async function resolveBuyerSession(
  _request: Request,
): Promise<BuyerSession | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(BHC_MEMBER_COOKIE);
  if (!cookie?.value) return null;
  let decoded: any;
  try {
    decoded = jwt.verify(cookie.value, JWT_SECRET);
  } catch {
    return null;
  }
  if (decoded.type !== 'member-session') return null;
  return {
    consumerId: String(decoded.consumerId || ''),
    email: String(decoded.email || ''),
    name: String(decoded.name || ''),
    state: String(decoded.state || ''),
  };
}

/**
 * Wrapper for route handlers that need a buyer session.
 *
 * Returns:
 *   - `{ session }` on success
 *   - 401 NextResponse when no session resolves
 *
 * Usage:
 *   const r = await requireBuyer(request);
 *   if (r instanceof NextResponse) return r;
 *   const { session } = r;
 */
export async function requireBuyer(
  request: Request,
): Promise<{ session: BuyerSession } | NextResponse> {
  const session = await resolveBuyerSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return { session };
}
