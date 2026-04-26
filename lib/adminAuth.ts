import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * Centralized admin auth check.
 *
 * Accepts EITHER:
 *   - The `bhc-admin-auth` cookie set by /api/admin/auth (browser sessions)
 *   - `?password=...` query param matching ADMIN_PASSWORD (CLI / curl / scripted ops)
 *   - `x-admin-password` header matching ADMIN_PASSWORD (programmatic clients)
 *
 * Returns `null` if authorized. Returns a `NextResponse` 401 if not — callers
 * should `if (response) return response;` at the top of their handler.
 *
 * Why a helper instead of middleware: Next.js middleware can't read cookies the
 * same way during streaming responses, and several admin endpoints accept the
 * password in URL/header form for the Telegram bot + cron-style scripts.
 */
export async function requireAdmin(request: Request): Promise<NextResponse | null> {
  // 1. Cookie auth (set by POST /api/admin/auth)
  try {
    const cookieStore = await cookies();
    const cookie = cookieStore.get('bhc-admin-auth');
    if (cookie?.value === 'authenticated') return null;
  } catch {
    // Cookies may not be available in some contexts — fall through to header/query
  }

  // 2. Header auth: x-admin-password
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminPassword) {
    const headerPw = request.headers.get('x-admin-password');
    if (headerPw && headerPw === adminPassword) return null;

    // 3. Query param auth: ?password=...
    try {
      const url = new URL(request.url);
      const queryPw = url.searchParams.get('password');
      if (queryPw && queryPw === adminPassword) return null;
    } catch {
      // Invalid URL — treat as unauthorized
    }
  }

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
