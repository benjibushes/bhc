// Auth Phase 1 — Clerk for buyer surface (feature-flag gated).
//
// Two-layer buyer auth resolver. The legacy `bhc-member-auth` JWT cookie
// (issued by magic-link verify + warmup engage) coexists with a Clerk
// session, gated by `CLERK_BUYER_ENABLED`. Both paths produce the same
// BuyerSession shape so callers don't branch on `source`.
//
// Migration timeline:
//   Phase 1 ship (this file): flag default false → 100% legacy. No buyer
//     behavior changes. Clerk path code-complete but inert.
//   Flip flag → true: new buyer logins go through Clerk; existing 1500
//     buyers with active bhc-member-auth cookies keep working until their
//     30-day cookie expires. First-time Clerk session for an existing
//     buyer auto-links their Consumers row by primary email.
//   Phase 2 (after 30-day soak): remove the legacy path entirely + drop
//     the cookie. Tracked separately so rollback is a flag flip, not a
//     code revert.
//
// See docs/AUTH-CLERK-BUYER.md for operator playbook.

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth as clerkAuth, clerkClient } from '@clerk/nextjs/server';
import jwt from 'jsonwebtoken';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';

const BHC_MEMBER_COOKIE = 'bhc-member-auth';

/**
 * Tagged error for Clerk infrastructure failures (API outage, rate limit,
 * etc). Distinguished from "Clerk session has no matching Consumers row"
 * — that case returns null and refuses legacy fallback as impersonation
 * defense. A ClerkApiError, by contrast, is operational: the request
 * should 503 + retry, not 401.
 */
export class ClerkApiError extends Error {
  cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'ClerkApiError';
    this.cause = cause;
  }
}

export interface BuyerSession {
  consumerId: string;
  email: string;
  name: string;
  state: string;
  source: 'clerk' | 'legacy-jwt';
}

export const CLERK_BUYER_ENABLED = process.env.CLERK_BUYER_ENABLED === 'true';

/**
 * Resolve the buyer session for an incoming request.
 *
 * Behavior:
 *   - If CLERK_BUYER_ENABLED === 'true' AND a Clerk session is present:
 *     returns the Consumers row matched by Clerk user id (or by Clerk
 *     primary email when the row hasn't been linked yet — first-login
 *     auto-link). Source: 'clerk'.
 *   - ELSE: falls back to the legacy bhc-member-auth JWT cookie.
 *     Source: 'legacy-jwt'.
 *   - Returns null if neither path produces a valid buyer.
 *
 * Why both paths coexist:
 *   - Flag off  → 100% of buyers stay on legacy JWT (no change)
 *   - Flag on   → existing cookies still work until expiry; new logins
 *                 mint a Clerk session that links to their Consumers row
 *   - After 30d → legacy JWT path removed in a separate cleanup commit
 *
 * Important: if a Clerk session exists but no Consumers row matches,
 * we DO NOT fall through to the legacy cookie path. Otherwise a Clerk
 * user could effectively impersonate any stale buyer who happened to
 * leave a valid bhc-member-auth cookie in this browser.
 */
export async function resolveBuyerSession(
  request: Request,
): Promise<BuyerSession | null> {
  // Clerk path — only when the flag is flipped on
  if (CLERK_BUYER_ENABLED) {
    let userId: string | null = null;
    try {
      const session = await clerkAuth();
      userId = session.userId;
    } catch {
      // No Clerk request context (cron, internal call, etc.) — fall
      // through to legacy. clerkAuth() throws outside the middleware-aware
      // request scope.
    }
    if (userId) {
      // ClerkApiError bubbles up. resolveClerkBuyer null = no buyer row
      // matched (refuse legacy fallback). Session = success.
      const session = await resolveClerkBuyer(userId);
      if (session) return session;
      // Clerk session present but no buyer row found — refuse rather
      // than fall through to the legacy cookie (see security note above).
      return null;
    }
  }

  // Legacy JWT path — always available; the only path when flag is off
  return resolveLegacyJwt(request);
}

async function resolveClerkBuyer(
  clerkUserId: string,
): Promise<BuyerSession | null> {
  // 1. Fast path — already linked. Look up the Consumers row by Clerk User Id.
  const safeId = clerkUserId.replace(/"/g, '\\"');
  let linked: any[] = [];
  try {
    linked = await getAllRecords(
      TABLES.CONSUMERS,
      `{Clerk User Id} = "${safeId}"`,
    );
  } catch (e: any) {
    console.warn('[buyerAuth] Clerk User Id lookup failed:', e?.message);
  }
  if (linked[0]) {
    const row: any = linked[0];
    return {
      consumerId: row.id,
      email: String(row['Email'] || ''),
      name: String(row['Full Name'] || ''),
      state: String(row['State'] || ''),
      source: 'clerk',
    };
  }

  // 2. First-login auto-link. Fetch the Clerk user's primary email,
  //    find the matching Consumers row by email, write Clerk User Id back.
  let clerkEmail = '';
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(clerkUserId);
    clerkEmail = String(
      user.primaryEmailAddress?.emailAddress || '',
    ).toLowerCase();
  } catch (e) {
    // Clerk API failure (transient outage, rate limit, etc) is OPERATIONAL,
    // not a security event. Throwing a tagged ClerkApiError lets the caller
    // distinguish "Clerk is down" (→ 503, client retries) from "Clerk session
    // points at a user that doesn't match any Consumers row" (→ 401, refuse
    // legacy fallback as impersonation defense).
    console.warn('[buyerAuth] clerkClient.getUser failed:', e);
    throw new ClerkApiError('clerk_get_user_failed', e);
  }
  if (!clerkEmail) return null;

  const safeEmail = clerkEmail.replace(/"/g, '\\"');
  let byEmail: any[] = [];
  try {
    byEmail = await getAllRecords(
      TABLES.CONSUMERS,
      `LOWER({Email}) = "${safeEmail}"`,
    );
  } catch (e: any) {
    console.warn('[buyerAuth] Consumers email lookup failed:', e?.message);
    return null;
  }
  const row: any = byEmail[0];
  if (!row) return null;

  // Link the row to the Clerk user id (idempotent — only write when empty).
  // Non-fatal if it fails; we still resolve the session on this request and
  // try again on the next one.
  try {
    if (!row['Clerk User Id']) {
      await updateRecord(TABLES.CONSUMERS, row.id, {
        'Clerk User Id': clerkUserId,
      });
    }
  } catch (e: any) {
    console.warn(
      '[buyerAuth] Clerk User Id link write failed:',
      e?.message,
    );
  }

  return {
    consumerId: row.id,
    email: clerkEmail,
    name: String(row['Full Name'] || ''),
    state: String(row['State'] || ''),
    source: 'clerk',
  };
}

async function resolveLegacyJwt(
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
    source: 'legacy-jwt',
  };
}

/**
 * Wrapper for route handlers that need a buyer session.
 *
 * Returns:
 *   - `{ session }` on success
 *   - 401 NextResponse when no session resolves (no Clerk + no JWT, OR
 *     Clerk session exists w/ no matching Consumers row)
 *   - 503 NextResponse when Clerk's upstream API is failing (transient
 *     outage / rate limit). Operational, not security — client should
 *     retry. Distinguishing this from 401 prevents Clerk-outage
 *     cascades that mass-401 every buyer-gated request.
 *
 * Usage:
 *   const r = await requireBuyer(request);
 *   if (r instanceof NextResponse) return r;
 *   const { session } = r;
 */
export async function requireBuyer(
  request: Request,
): Promise<{ session: BuyerSession } | NextResponse> {
  try {
    const session = await resolveBuyerSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return { session };
  } catch (e) {
    if (e instanceof ClerkApiError) {
      // Clerk upstream failure — let the client retry. Don't 401 a buyer
      // just because Clerk is degraded.
      return NextResponse.json(
        { error: 'Auth service temporarily unavailable. Please retry.' },
        { status: 503 },
      );
    }
    throw e;
  }
}
