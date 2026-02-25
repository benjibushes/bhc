import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ADMIN_AUTH_COOKIE = 'bhc-admin-auth';

const PUBLIC_ADMIN_ROUTES = [
  '/api/admin/auth',
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Protect admin API routes
  if (pathname.startsWith('/api/admin/') || pathname.startsWith('/api/referrals')) {
    // Allow public routes (login/logout/check)
    if (PUBLIC_ADMIN_ROUTES.some(route => pathname.startsWith(route))) {
      return NextResponse.next();
    }

    const authCookie = request.cookies.get(ADMIN_AUTH_COOKIE);
    if (authCookie?.value !== 'authenticated') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Protect Telegram webhook with secret token
  if (pathname === '/api/webhooks/telegram') {
    const secretToken = request.headers.get('x-telegram-bot-api-secret-token');
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret && secretToken !== expectedSecret) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
    '/api/webhooks/telegram',
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
