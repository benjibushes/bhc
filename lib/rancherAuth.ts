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
// DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
// lib/demo/demoMode.ts.
import { isDemoMode } from '@/lib/demo/demoMode';
// Wave C (2026-07-14) — 24h cached session re-validation (pure logic +
// rationale in lib/rancherSessionRevalidate.ts).
import {
  needsRevalidation,
  sessionRevalidationVerdict,
  SESSION_REVALIDATE_INTERVAL_MS,
} from '@/lib/rancherSessionRevalidate';

const BHC_RANCHER_COOKIE = 'bhc-rancher-auth';

// Warm-instance memory of successful re-checks, keyed rancherId:email. This
// is the cache that keeps the re-check to AT MOST one Airtable read per
// session per 24h even when the cookie can't be re-minted (e.g. a server
// component render, where cookie writes throw). Per-process only — a cold
// start simply re-checks once, which is the safe direction.
const _revalidatedAt = new Map<string, number>();

// The demo rancher session — returned with NO cookie when demo mode is on, so
// every /api/rancher/* route auto-authenticates as the flagship demo rancher.
// Field values mirror the demo Ranchers fixture (lib/demo/demoStore.ts).
function demoRancherSession(): RancherSession {
  return {
    rancherId: 'recDEMOrancher01x',
    email: 'sam@democreekcattle.example',
    name: 'Sam Rivers',
    ranchName: 'Demo Creek Cattle Co',
    state: 'MT',
    impersonatedBy: null,
  };
}

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
 *
 * Wave C (2026-07-14): the session is also RE-VALIDATED against the live
 * Ranchers row at most once per 24h (cheap cached re-check — the cookie's
 * revalidatedAt claim + a warm-instance map keep the hot path at ZERO added
 * Airtable reads). Pre-fix, status checks lived only at login: removing a
 * Team Email, marking Non-Compliant, or closing an account never cut an
 * existing 30-day cookie — a fired ranch hand kept owner-privilege access
 * (buyer PII, earnings CSV, request-deposit, email edits) with no revocation
 * mechanism short of rotating JWT_SECRET platform-wide. Revocation latency
 * is now ≤24h across every /api/rancher/* route. Airtable-outage reads FAIL
 * OPEN (don't lock every rancher out during a blip); verdict failures delete
 * the cookie and return null.
 */
export async function resolveRancherSession(
  _request: Request,
): Promise<RancherSession | null> {
  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
  // lib/demo/demoMode.ts. Auto-authenticate as the demo rancher with no cookie.
  if (isDemoMode()) return demoRancherSession();
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
  const session: RancherSession = {
    rancherId: String(decoded.rancherId || ''),
    email: String(decoded.email || ''),
    name: String(decoded.name || ''),
    ranchName: String(decoded.ranchName || ''),
    state: String(decoded.state || ''),
    impersonatedBy: decoded.impersonatedBy || null,
  };

  // ── 24h cached re-check ──────────────────────────────────────────────────
  const now = Date.now();
  if (needsRevalidation(decoded, now)) {
    const cacheKey = `${session.rancherId}:${session.email.toLowerCase()}`;
    const cachedOkAt = _revalidatedAt.get(cacheKey);
    if (!cachedOkAt || now - cachedOkAt >= SESSION_REVALIDATE_INTERVAL_MS) {
      let rancher: Record<string, unknown> | null = null;
      let readFailed = false;
      try {
        // Dynamic import keeps the Airtable module off this hot auth path
        // except in the ≤once-per-24h branch (and avoids import cycles).
        const { getRecordById, TABLES } = await import('@/lib/airtable');
        rancher = (await getRecordById(TABLES.RANCHERS, session.rancherId)) as any;
      } catch (e: any) {
        // Airtable blip — fail OPEN without stamping the cache so the next
        // request retries the check.
        readFailed = true;
        console.warn('[rancherAuth] session re-check read failed (fail-open):', e?.message);
      }
      if (!readFailed) {
        const verdict = sessionRevalidationVerdict(rancher, session);
        if (!verdict.ok) {
          console.warn(
            `[rancherAuth] session revoked (${verdict.reason}) — rancher ${session.rancherId}, session email ${session.email}`,
          );
          _revalidatedAt.delete(cacheKey);
          try {
            cookieStore.delete(BHC_RANCHER_COOKIE);
          } catch {
            /* cookie writes throw outside route handlers — the null return
               below still denies this request, and every subsequent request
               re-runs the (memory-cached-miss) check and denies again. */
          }
          return null;
        }
        _revalidatedAt.set(cacheKey, now);
        // Re-mint the cookie with a fresh revalidatedAt, PRESERVING the
        // original expiry (exp in payload, no expiresIn — a re-check must
        // not turn 30-day sessions into immortal sliding sessions).
        if (typeof decoded.exp === 'number') {
          try {
            const reminted = jwt.sign(
              {
                type: 'rancher-session',
                rancherId: session.rancherId,
                email: session.email,
                name: session.name,
                ranchName: session.ranchName,
                state: session.state,
                ...(session.impersonatedBy ? { impersonatedBy: session.impersonatedBy } : {}),
                revalidatedAt: now,
                exp: decoded.exp,
              },
              JWT_SECRET,
            );
            cookieStore.set(BHC_RANCHER_COOKIE, reminted, {
              httpOnly: true,
              secure: process.env.NODE_ENV === 'production',
              sameSite: 'lax',
              maxAge: Math.max(60, decoded.exp - Math.floor(now / 1000)),
              path: '/',
            });
          } catch {
            /* server-component render — memory cache carries the freshness */
          }
        }
      }
    }
  }

  return session;
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
