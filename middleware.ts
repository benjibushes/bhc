import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ADMIN_AUTH_COOKIE = 'bhc-admin-auth';

const PUBLIC_ADMIN_ROUTES = [
  '/api/admin/auth',
];

// Accept any of: bhc-admin-auth cookie, ?password= query, or x-admin-password header.
// Match the surface that lib/adminAuth.ts uses inside route handlers so scripted
// callers (Telegram bot, ops scripts, monitoring) can authenticate without first
// POSTing /api/admin/auth to get a cookie. Several existing endpoints already
// document password-query access (route-state-to-rancher, setup-ai-fields,
// setup-rancher-page-fields, backfill-states) but middleware was rejecting them
// before this change.
function isAdminAuthed(request: NextRequest): boolean {
  if (request.cookies.get(ADMIN_AUTH_COOKIE)?.value === 'authenticated') return true;
  const adminPw = process.env.ADMIN_PASSWORD;
  if (adminPw) {
    const headerPw = request.headers.get('x-admin-password');
    if (headerPw && headerPw === adminPw) return true;
    const queryPw = request.nextUrl.searchParams.get('password');
    if (queryPw && queryPw === adminPw) return true;
  }
  return false;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Protect admin API routes
  if (pathname.startsWith('/api/admin/') || pathname.startsWith('/api/referrals')) {
    // Allow public routes (login/logout/check)
    if (PUBLIC_ADMIN_ROUTES.some(route => pathname.startsWith(route))) {
      return NextResponse.next();
    }

    if (!isAdminAuthed(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Protect inquiry management (GET/PATCH/DELETE) — POST is the public contact form
  if (pathname.startsWith('/api/inquiries') && request.method !== 'POST') {
    if (!isAdminAuthed(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Protect affiliate dashboard API (requires affiliate session cookie)
  if (pathname.startsWith('/api/affiliate/')) {
    const affiliateCookie = request.cookies.get('bhc-affiliate-auth');
    if (!affiliateCookie?.value) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const response = NextResponse.next();

  // Security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  return response;
}

export const config = {
  matcher: [
    '/api/admin/:path*',
    '/api/referrals/:path*',
    '/api/inquiries/:path*',
    '/api/affiliate/:path*',
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
