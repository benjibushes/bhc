import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { verifyJwtWithFallback } from './jwt';
import { ADMIN_PASSWORD } from './secrets';

/**
 * Centralized admin auth check.
 *
 * Accepts EITHER:
 *   - The `bhc-admin-auth` cookie set by /api/admin/auth (browser sessions).
 *     P3-C (2026-05-27): cookie is now a SIGNED JWT with claims { role, iat },
 *     verified via verifyJwtWithFallback for JWT_SECRET rotation grace.
 *   - `x-admin-password` header matching ADMIN_PASSWORD (programmatic clients)
 *   - `?password=` in non-prod matching ADMIN_PASSWORD (DEPRECATED)
 *
 * --- PARTNER ROLES (2026-06-19) ---
 * The login route (/api/admin/auth POST) now issues JWTs with role-specific
 * values: 'admin' | 'onboarding' | 'ads'. Every route continues to call
 * requireAdmin() (which only allows role='admin'), EXCEPT for a small,
 * explicitly opened surface that calls requireRole(request, [...]).
 *
 * requireAdmin() is a thin wrapper around requireRole(request, ['admin'])
 * so every existing caller is automatically backward-compatible.
 *
 * Header / ?password= paths always authorize as 'admin' (owner ops scripts).
 *
 * DEFAULT-DENY: routes that don't call this (or call requireAdmin) stay
 * admin-only. Only explicitly opened routes may call requireRole with a
 * partner role in the allowed list.
 *
 * Returns `null` if authorized. Returns a `NextResponse` 401 if not — callers
 * should `if (response) return response;` at the top of their handler.
 *
 * Why a helper instead of middleware: Next.js middleware can't read cookies the
 * same way during streaming responses, and several admin endpoints accept the
 * password in URL/header form for the Telegram bot + cron-style scripts.
 */

export interface AdminTokenClaims {
  role: string;
  iat?: number;
  exp?: number;
}

// Constant-time compare to defeat timing-attacks. P0 audit fix (C-2).
function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  const maxLen = Math.max(aBuf.length, bBuf.length, 1);
  const aPad = Buffer.alloc(maxLen);
  const bPad = Buffer.alloc(maxLen);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  const eq = crypto.timingSafeEqual(aPad, bPad);
  return eq && aBuf.length === bBuf.length;
}

/**
 * requireRole — authorize if the cookie role is in `allowed`, OR if the
 * x-admin-password header / ?password= matches ADMIN_PASSWORD (those paths
 * always grant full admin access and satisfy any `allowed` list that includes
 * 'admin').
 *
 * This is the single enforcement point. Use requireAdmin() for admin-only
 * routes (all existing routes). Use requireRole(req, ['admin','onboarding'])
 * or requireRole(req, ['admin','ads']) only on explicitly opened surfaces.
 */
export async function requireRole(
  request: Request,
  allowed: string[],
): Promise<NextResponse | null> {
  // 1. Cookie auth (set by POST /api/admin/auth)
  try {
    const cookieStore = await cookies();
    const cookie = cookieStore.get('bhc-admin-auth');
    if (cookie?.value) {
      try {
        const claims = verifyJwtWithFallback<AdminTokenClaims>(cookie.value);
        if (claims.role && allowed.includes(claims.role)) return null;
      } catch {
        // Bad / expired / unsigned cookie — fall through to header/query auth
      }
    }
  } catch {
    // Cookies may not be available in some contexts — fall through
  }

  // 2. Header auth: x-admin-password — ALWAYS authorizes as 'admin'.
  // Partner tokens (cookies) can only reach routes explicitly opened to them;
  // the header path is ops-script-only and always grants full admin.
  if (ADMIN_PASSWORD) {
    const headerPw = request.headers.get('x-admin-password');
    if (headerPw && safeEqual(headerPw, ADMIN_PASSWORD)) return null;

    // 3. Query param auth: ?password=... — DEPRECATED 2026-05-20
    // Kept for backwards compat in non-prod only. Same admin-only semantics.
    if (process.env.NODE_ENV !== 'production') {
      try {
        const url = new URL(request.url);
        const queryPw = url.searchParams.get('password');
        if (queryPw && safeEqual(queryPw, ADMIN_PASSWORD)) return null;
      } catch {
        // Invalid URL — treat as unauthorized
      }
    }
  }

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * requireAdmin — only admits role='admin' (or the header/query password paths).
 * All existing callers are backward-compatible; this now delegates to requireRole.
 */
export async function requireAdmin(request: Request): Promise<NextResponse | null> {
  return requireRole(request, ['admin']);
}
