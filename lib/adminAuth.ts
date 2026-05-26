import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';

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
  // 1. Server-to-server: x-admin-password header
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminPassword) {
    const headerPw = request.headers.get('x-admin-password');
    if (headerPw && headerPw === adminPassword) return null;
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
  const userEmail = String(
    (sessionClaims as Record<string, unknown> | null)?.email ?? ''
  ).toLowerCase();
  const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (ADMIN_EMAILS.length > 0 && !ADMIN_EMAILS.includes(userEmail)) {
    return NextResponse.json(
      { error: 'Not authorized as admin' },
      { status: 403 }
    );
  }

  return null;
}
