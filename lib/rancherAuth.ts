// Auth Phase 2 — Clerk for rancher surface (feature-flag gated).
//
// Two-layer rancher auth resolver. The legacy `bhc-rancher-auth` JWT
// cookie (issued by magic-link verify + admin impersonate) coexists
// with a Clerk session, gated by `CLERK_RANCHER_ENABLED`. Both paths
// produce the same RancherSession shape so callers don't branch on
// `source`.
//
// Migration timeline:
//   Phase 2 ship (this file): flag default false → 100% legacy. No
//     rancher behavior changes. Clerk path code-complete but inert.
//   Flip flag → true: new rancher logins go through Clerk; existing
//     17 ranchers with active bhc-rancher-auth cookies keep working
//     until their 30-day cookie expires. First-time Clerk session for
//     an existing rancher auto-links their Ranchers row by either the
//     primary `Email` field OR any value in `Team Emails`.
//   Phase 3 (after 30-day soak): remove the legacy path entirely + drop
//     the cookie. Tracked separately so rollback is a flag flip, not a
//     code revert.
//
// Mirrors lib/buyerAuth.ts (Phase 1). The only meaningful divergence:
// ranchers can have multiple authorized emails (operator + spouse +
// hired help) via the `Team Emails` field, so the auto-link lookup
// also searches that multiline list.
//
// See docs/AUTH-CLERK-RANCHER.md for operator playbook.

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth as clerkAuth, clerkClient } from '@clerk/nextjs/server';
import jwt from 'jsonwebtoken';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';

const BHC_RANCHER_COOKIE = 'bhc-rancher-auth';

/**
 * Tagged error for Clerk infrastructure failures (API outage, rate
 * limit, etc). Distinguished from "Clerk session has no matching
 * Ranchers row" — that case returns null and refuses legacy fallback
 * as impersonation defense. A ClerkApiError, by contrast, is
 * operational: the request should 503 + retry, not 401.
 */
export class ClerkApiError extends Error {
  cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'ClerkApiError';
    this.cause = cause;
  }
}

export interface RancherSession {
  rancherId: string;
  email: string; // The email that authenticated (could be primary OR team)
  name: string; // Operator Name (or Ranch Name fallback)
  ranchName: string;
  state: string;
  source: 'clerk' | 'legacy-jwt';
  // Preserve admin impersonation surface from the legacy JWT path so
  // the dashboard can keep rendering admin-only controls (e.g. "Revive
  // Lead" on Closed Lost referrals). Always null under Clerk.
  impersonatedBy?: string | null;
}

export const CLERK_RANCHER_ENABLED =
  process.env.CLERK_RANCHER_ENABLED === 'true';

/**
 * Resolve the rancher session for an incoming request.
 *
 * Behavior:
 *   - If CLERK_RANCHER_ENABLED === 'true' AND a Clerk session is present:
 *     returns the Ranchers row matched by Clerk user id (or by Clerk
 *     primary email — checking Email + Team Emails — when the row
 *     hasn't been linked yet, first-login auto-link). Source: 'clerk'.
 *   - ELSE: falls back to the legacy bhc-rancher-auth JWT cookie.
 *     Source: 'legacy-jwt'.
 *   - Returns null if neither path produces a valid rancher.
 *
 * Why both paths coexist:
 *   - Flag off  → 100% of ranchers stay on legacy JWT (no change)
 *   - Flag on   → existing cookies still work until expiry; new logins
 *                 mint a Clerk session that links to their Ranchers row
 *   - After 30d → legacy JWT path removed in a separate cleanup commit
 *
 * Important: if a Clerk session exists but no Ranchers row matches,
 * we DO NOT fall through to the legacy cookie path. Otherwise a Clerk
 * user could effectively impersonate any stale rancher who happened to
 * leave a valid bhc-rancher-auth cookie in this browser.
 */
export async function resolveRancherSession(
  request: Request,
): Promise<RancherSession | null> {
  // Clerk path — only when the flag is flipped on
  if (CLERK_RANCHER_ENABLED) {
    let userId: string | null = null;
    try {
      const session = await clerkAuth();
      userId = session.userId;
    } catch {
      // No Clerk request context (cron, internal call, etc.) — fall
      // through to legacy. clerkAuth() throws outside the
      // middleware-aware request scope.
    }
    if (userId) {
      // ClerkApiError bubbles up. resolveClerkRancher null = no
      // rancher row matched (refuse legacy fallback). Session =
      // success.
      const session = await resolveClerkRancher(userId);
      if (session) return session;
      // Clerk session present but no rancher row found — refuse
      // rather than fall through to the legacy cookie (see security
      // note above).
      return null;
    }
  }

  // Legacy JWT path — always available; the only path when flag is off
  return resolveLegacyJwt(request);
}

async function resolveClerkRancher(
  clerkUserId: string,
): Promise<RancherSession | null> {
  // 1. Fast path — already linked. Look up the Ranchers row by Clerk
  //    User Id.
  const safeId = clerkUserId.replace(/"/g, '\\"');
  let linked: any[] = [];
  try {
    linked = await getAllRecords(
      TABLES.RANCHERS,
      `{Clerk User Id} = "${safeId}"`,
    );
  } catch (e: any) {
    console.warn('[rancherAuth] Clerk User Id lookup failed:', e?.message);
  }
  if (linked[0]) {
    const row: any = linked[0];
    return {
      rancherId: row.id,
      email: String(row['Email'] || ''),
      name: String(row['Operator Name'] || row['Ranch Name'] || ''),
      ranchName: String(row['Ranch Name'] || ''),
      state: String(row['State'] || ''),
      source: 'clerk',
      impersonatedBy: null,
    };
  }

  // 2. First-login auto-link. Fetch the Clerk user's primary email,
  //    find the matching Ranchers row by email (Email OR Team Emails),
  //    write Clerk User Id back idempotently.
  let clerkEmail = '';
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(clerkUserId);
    clerkEmail = String(
      user.primaryEmailAddress?.emailAddress || '',
    ).toLowerCase();
  } catch (e) {
    // Clerk API failure (transient outage, rate limit, etc) is
    // OPERATIONAL, not a security event. Throwing a tagged
    // ClerkApiError lets the caller distinguish "Clerk is down" (→
    // 503, client retries) from "Clerk session points at a user that
    // doesn't match any Ranchers row" (→ 401, refuse legacy fallback
    // as impersonation defense).
    console.warn('[rancherAuth] clerkClient.getUser failed:', e);
    throw new ClerkApiError('clerk_get_user_failed', e);
  }
  if (!clerkEmail) return null;

  // Ranchers can have multiple authorized emails (operator + spouse +
  // hired help) via the `Team Emails` multiline field. We need to
  // match either the primary `Email` exactly OR find the address as a
  // substring of the lowercased Team Emails blob.
  //
  // SEARCH() is case-sensitive on the haystack, so we lowercase both
  // sides via LOWER(). False positives are possible if one team email
  // is a substring of another (e.g. `ben@x.com` matches the start of
  // `unben@x.com`). For 17 ranchers operators self-police; the magic
  // link login uses tokenized delimiter splitting in memory so it's
  // tighter — we re-verify in memory below to be safe.
  const safeEmail = clerkEmail.replace(/"/g, '\\"');
  let byEmail: any[] = [];
  try {
    byEmail = await getAllRecords(
      TABLES.RANCHERS,
      `OR(LOWER({Email}) = "${safeEmail}", SEARCH("${safeEmail}", LOWER({Team Emails})))`,
    );
  } catch (e: any) {
    console.warn('[rancherAuth] Ranchers email lookup failed:', e?.message);
    return null;
  }

  // Tighten the substring SEARCH match by re-validating against
  // delimiter-split Team Emails in memory. This kills false positives
  // (`ben@x.com` inside `unben@x.com`). Same parsing rule as
  // /api/auth/rancher/login uses for the magic-link path.
  const splitRe = /[\s,;\n]+/;
  const matches = byEmail.filter((r: any) => {
    const primary = String(r['Email'] || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '');
    if (primary && primary === clerkEmail) return true;
    const teamList = String(r['Team Emails'] || '')
      .toLowerCase()
      .split(splitRe)
      .map((s: string) => s.trim())
      .filter(Boolean);
    return teamList.includes(clerkEmail);
  });

  // Multi-team-match: a consultant on multiple ranches' Team Emails
  // could legitimately have several hits. Pick the most-recently
  // active one, mirroring the heuristic the magic-link login uses.
  let row: any = null;
  if (matches.length === 1) {
    row = matches[0];
  } else if (matches.length > 1) {
    const recencyMs = (r: any): number => {
      const candidates = [
        r['Last Assigned At'],
        r['Agreement Signed At'],
        r['Docs Sent At'],
        r._createdTime,
      ].map((d) => (d ? new Date(d).getTime() : 0));
      return Math.max(...candidates, 0);
    };
    matches.sort((a: any, b: any) => recencyMs(b) - recencyMs(a));
    row = matches[0];
    console.log(
      `[rancherAuth] multi-match email=${clerkEmail} → picked ${row.id} of ${matches.length} candidates`,
    );
  }
  if (!row) return null;

  // Link the row to the Clerk user id (idempotent — only write when
  // empty). Non-fatal if it fails; we still resolve the session on
  // this request and try again on the next one.
  try {
    if (!row['Clerk User Id']) {
      await updateRecord(TABLES.RANCHERS, row.id, {
        'Clerk User Id': clerkUserId,
      });
    }
  } catch (e: any) {
    console.warn(
      '[rancherAuth] Clerk User Id link write failed:',
      e?.message,
    );
  }

  return {
    rancherId: row.id,
    email: clerkEmail,
    name: String(row['Operator Name'] || row['Ranch Name'] || ''),
    ranchName: String(row['Ranch Name'] || ''),
    state: String(row['State'] || ''),
    source: 'clerk',
    impersonatedBy: null,
  };
}

async function resolveLegacyJwt(
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
    source: 'legacy-jwt',
    impersonatedBy: decoded.impersonatedBy || null,
  };
}

/**
 * Wrapper for route handlers that need a rancher session.
 *
 * Returns:
 *   - `{ session }` on success
 *   - 401 NextResponse when no session resolves (no Clerk + no JWT, OR
 *     Clerk session exists w/ no matching Ranchers row)
 *   - 503 NextResponse when Clerk's upstream API is failing (transient
 *     outage / rate limit). Operational, not security — client should
 *     retry. Distinguishing this from 401 prevents Clerk-outage
 *     cascades that mass-401 every rancher-gated request.
 *
 * Usage:
 *   const r = await requireRancher(request);
 *   if (r instanceof NextResponse) return r;
 *   const { session } = r;
 */
export async function requireRancher(
  request: Request,
): Promise<{ session: RancherSession } | NextResponse> {
  try {
    const session = await resolveRancherSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return { session };
  } catch (e) {
    if (e instanceof ClerkApiError) {
      // Clerk upstream failure — let the client retry. Don't 401 a
      // rancher just because Clerk is degraded.
      return NextResponse.json(
        { error: 'Auth service temporarily unavailable. Please retry.' },
        { status: 503 },
      );
    }
    throw e;
  }
}
