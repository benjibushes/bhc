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
import { mintBuyerSessionToken, type BuyerSessionClaims } from './buyerSession';
import { DEPOSIT_GRANT_COOKIE, verifyDepositGrantToken, type DepositGrantPayload } from './campaignReserve';

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
 * Resolve auth for the DEPOSIT FLOW specifically (deposit checkout, post-deposit
 * preferences, the buyer↔rancher thread for one referral), scoped to a single
 * referralId.
 *
 * Accepts EITHER:
 *   1. the full member-session cookie (a logged-in buyer), OR
 *   2. the referral-scoped `bhc-deposit-grant` capability cookie, but ONLY when
 *      it names this exact referralId (campaign 1-tap link path).
 *
 * SECURITY: the deposit-grant cookie is the ONLY thing this adds over
 * resolveBuyerSession, and it is deliberately consulted nowhere outside the
 * deposit flow — /member, /api/member/*, reorder, upgrade-intent, qualify all
 * keep using resolveBuyerSession (member-session only). So a forwarded campaign
 * link's grant can authorize at most this one referral's deposit/preferences/
 * thread and can NEVER reach the buyer's dashboard or start new orders. The
 * referralId binding (verifyDepositGrantToken's expectReferralId) further pins
 * it to one checkout, so a grant for referral A can't act on referral B.
 * (Thread-SCOPED deposit-flow routes use readDepositGrantPayload below and
 * enforce the same referral pin against the thread's Referral link themselves.)
 *
 * Returns a BuyerSession-shaped object. For the grant path only `consumerId` is
 * known from the token (email/name/state default to ''); every deposit-flow
 * route authorizes on `consumerId` ∈ referral.Buyer, so that's sufficient, and
 * buyer email is read from the referral itself where needed (deposit route).
 */
export async function resolveDepositAuth(
  request: Request,
  referralId: string,
): Promise<BuyerSession | null> {
  // 1) Full member session takes precedence (richest identity).
  const member = await resolveBuyerSession(request);
  if (member) return member;

  // 2) Referral-scoped deposit grant.
  const cookieStore = await cookies();
  const grant = cookieStore.get(DEPOSIT_GRANT_COOKIE);
  if (!grant?.value) return null;
  const res = verifyDepositGrantToken(grant.value, referralId);
  if (!res.ok) return null;
  return {
    consumerId: res.payload.consumerId,
    email: '',
    name: '',
    state: '',
  };
}

/**
 * Read + verify the deposit-grant cookie WITHOUT a referral pin.
 *
 * For THREAD-scoped deposit-flow routes (/api/threads/[id]/message) that must
 * resolve the thread's linked referral BEFORE they can enforce the grant's
 * referral scope — and that need to distinguish "no credential at all" (401)
 * from "valid grant, but for a different referral" (403), which
 * resolveDepositAuth's single null cannot express.
 *
 * SECURITY: callers MUST enforce payload.referralId against the resource
 * (lib/campaignReserve.depositGrantAuthorizesThread) — a payload from here is
 * an authenticated IDENTITY, not an authorization. Signature/purpose/expiry
 * are fully verified; only the referral pin is deferred to the caller.
 */
export async function readDepositGrantPayload(
  _request: Request,
): Promise<DepositGrantPayload | null> {
  const cookieStore = await cookies();
  const grant = cookieStore.get(DEPOSIT_GRANT_COOKIE);
  if (!grant?.value) return null;
  const res = verifyDepositGrantToken(grant.value);
  return res.ok ? res.payload : null;
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

const BHC_MEMBER_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, matches /api/qualify

// Re-export the pure minter (defined in ./buyerSession, which has no secrets.ts
// dependency so it's unit-testable) so callers keep importing from '@/lib/buyerAuth'.
export { mintBuyerSessionToken, type BuyerSessionClaims };

/**
 * Set the bhc-member-auth cookie on a NextResponse. Mirrors the cookie options
 * at app/api/qualify/route.ts:509-515 EXACTLY so resolveBuyerSession works on
 * both the quiz path and the direct-deposit path.
 */
export function setBuyerSessionCookie(res: NextResponse, claims: BuyerSessionClaims): NextResponse {
  res.cookies.set(BHC_MEMBER_COOKIE, mintBuyerSessionToken(claims), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: BHC_MEMBER_COOKIE_MAX_AGE,
    path: '/',
  });
  return res;
}

// Deposit-grant cookie lifetime — short, just long enough to outlive the
// checkout hop + a same-day return. Kept well under the member-session 30d
// because this is a forwardable-link capability, not a login.
const BHC_DEPOSIT_GRANT_MAX_AGE = 2 * 24 * 60 * 60; // 2 days

/**
 * Set the `bhc-deposit-grant` referral-scoped capability cookie on a
 * NextResponse. Used ONLY by the /r/d/<token> campaign-link route after it has
 * resolved the buyer's own referral. `mintedToken` is the deposit-grant JWT from
 * lib/campaignReserve.mintDepositGrantToken.
 *
 * Path is `/` (not /checkout) because the deposit flow spans two API roots —
 * /api/checkout/* (deposit + preferences) AND /api/threads/* (the buyer↔rancher
 * ask thread, including posting messages) — and a narrower path would starve
 * the thread endpoints. The containment boundary is NOT the cookie path: it's
 * that this cookie has exactly TWO readers, both in this file and both wired
 * exclusively into deposit-flow routes — resolveDepositAuth (referral-scoped
 * routes, pin enforced inside verifyDepositGrantToken) and
 * readDepositGrantPayload (the thread-scoped message route, which enforces the
 * same referral pin against the thread's Referral link via
 * depositGrantAuthorizesThread). /member + /api/member/* call
 * resolveBuyerSession, which never reads this cookie, so the grant is inert
 * there even though the browser sends it.
 */
export function setDepositGrantCookie(res: NextResponse, mintedToken: string): NextResponse {
  res.cookies.set(DEPOSIT_GRANT_COOKIE, mintedToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: BHC_DEPOSIT_GRANT_MAX_AGE,
    path: '/',
  });
  return res;
}
