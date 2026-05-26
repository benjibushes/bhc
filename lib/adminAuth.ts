import { NextResponse } from 'next/server';
import { auth, clerkClient } from '@clerk/nextjs/server';

/**
 * Constant-time string compare. Prevents timing attacks on the admin
 * password (Stage-3 ships LIVE Stripe refunds behind this gate; a measurable
 * timing differential would let an attacker probe character-by-character).
 * Pure JS XOR loop so it works on Edge runtime too (node:crypto unavailable
 * there). Length mismatch is the slow path but always runs full body.
 */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aLen = a.length;
  const bLen = b.length;
  // Compare against a fixed-length string so the body cost is constant
  // regardless of input. If lengths differ we still walk the longer string
  // but the result is forced false.
  const len = Math.max(aLen, bLen);
  let diff = aLen ^ bLen;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i % aLen || 1) ^ b.charCodeAt(i % bLen || 1));
  }
  return diff === 0 && aLen === bLen;
}

// Loud one-shot warning at module load when ADMIN_PASSWORD is missing in prod.
// Cron + Telegram bot use this header; without it they fall through to Clerk
// auth and get 401 with no obvious signal.
if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
  console.warn(
    '[lib/adminAuth] ADMIN_PASSWORD env is not set in production — server-to-server callers (Telegram bot, cron, ops scripts) will fail with 401. Set it in Vercel or expect downstream breakage.',
  );
}

// Loud one-shot warning at module load when ADMIN_EMAILS is missing in prod.
// Empty allowlist used to be fail-OPEN (any signed-in Clerk user could access
// /admin). Now fail-closed in prod (see ADMIN_EMAILS check below).
if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_EMAILS) {
  console.warn(
    '[lib/adminAuth] ADMIN_EMAILS env is not set in production — admin allowlist is empty, so ALL browser admin requests will be rejected with 403. Set ADMIN_EMAILS=ben@buyhalfcow.com (or similar) in Vercel.',
  );
}

/**
 * Centralized admin auth check — Auth Phase 0 (Clerk for browser admins).
 *
 * Accepts EITHER:
 *   1. `x-admin-password` header matching ADMIN_PASSWORD env (server-to-server:
 *      Telegram bot, cron jobs, ops curl). Their threat profile is different
 *      from a phishable human — secret lives in env, not in their head.
 *   2. A Clerk session whose primary email appears in the ADMIN_EMAILS
 *      allowlist (browser admin path with TOTP 2FA enforced by Clerk).
 *
 * The legacy `bhc-admin-auth` cookie path is REMOVED — Clerk's `__session`
 * cookie takes over. The DEV-only `?password=` query param is REMOVED
 * (audit finding #42, was already prod-disabled).
 *
 * Returns `null` if authorized. Returns a `NextResponse` 401/403 if not.
 * Callers should `if (response) return response;` at the top of their handler.
 *
 * Defense in depth: middleware.ts gates the same routes. This helper covers
 * route handlers that may be hit directly (server actions, internal calls).
 */
export async function requireAdmin(
  request: Request
): Promise<NextResponse | null> {
  // 1. Server-to-server: x-admin-password header (constant-time compare)
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminPassword) {
    const headerPw = request.headers.get('x-admin-password');
    if (headerPw && safeEqual(headerPw, adminPassword)) return null;
  }

  // 2. Browser session: Clerk auth + email allowlist
  let userId: string | null = null;
  let sessionClaims: Record<string, unknown> | null = null;
  try {
    const session = await auth();
    userId = session.userId;
    sessionClaims = (session.sessionClaims ?? null) as
      | Record<string, unknown>
      | null;
  } catch {
    // No Clerk session context (e.g. in non-request scope) — treat as unauth.
  }

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 3. Email allowlist (defense in depth)
  //
  // FAIL-CLOSED in production when ADMIN_EMAILS is empty. Previously this
  // was fail-open ("any signed-in Clerk user passes"), which is unsafe in
  // production where Clerk allows public sign-ups unless the dashboard
  // restricts them. Now an empty allowlist in prod rejects everyone — the
  // module-load warning above surfaces the missing config.
  const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (ADMIN_EMAILS.length === 0 && process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'Admin allowlist not configured' },
      { status: 403 }
    );
  }

  // Read email from session claims (cheap, no API call). If the custom
  // session token template doesn't expose `email` (Clerk Dashboard →
  // Sessions → Customize session token), fall back to a getUser() call.
  // Documented in docs/AUTH-CLERK-ADMIN.md.
  let userEmail = String(sessionClaims?.email ?? '').toLowerCase();
  if (!userEmail) {
    try {
      const client = await clerkClient();
      const user = await client.users.getUser(userId);
      userEmail = String(user.primaryEmailAddress?.emailAddress ?? '').toLowerCase();
    } catch (e) {
      console.warn('[lib/adminAuth] clerkClient.users.getUser failed:', e);
    }
  }

  if (ADMIN_EMAILS.length > 0 && (!userEmail || !ADMIN_EMAILS.includes(userEmail))) {
    return NextResponse.json(
      { error: 'Not authorized as admin' },
      { status: 403 }
    );
  }

  return null;
}
