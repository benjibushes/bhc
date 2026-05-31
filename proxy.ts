import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

/**
 * Constant-time string compare. Edge-runtime safe (no node:crypto). Stops a
 * timing-attack window on the ADMIN_PASSWORD secret — Stage-3 lives behind
 * this gate w/ real Stripe refund power, so the difference between
 * `===` (linear-time) and this loop matters even at Vercel network jitter.
 */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aLen = a.length;
  const bLen = b.length;
  const len = Math.max(aLen, bLen);
  let diff = aLen ^ bLen;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i % aLen || 1) ^ b.charCodeAt(i % bLen || 1));
  }
  return diff === 0 && aLen === bLen;
}

/**
 * Edge-runtime safe JWT verify with multi-secret rotation grace.
 *
 * P0 hotfix (2026-05-30): proxy.ts middleware was checking
 * `cookie.value === 'authenticated'` literal string after P3-C (2026-05-27)
 * upgraded the admin cookie to a signed JWT. Result: every valid JWT cookie
 * failed middleware → /admin redirected to /admin/login → "Checking…" forever
 * on every login attempt. Total admin lockout.
 *
 * Mirrors lib/jwt.ts::verifyJwtWithFallback but uses jose (Web Crypto API)
 * instead of jsonwebtoken (node:crypto). Required because middleware runs
 * in the edge runtime where node:crypto isn't available.
 */
async function verifyAdminJwt(token: string): Promise<{ role?: string } | null> {
  const primary = process.env.JWT_SECRET;
  if (!primary) return null;
  const legacySecrets = (process.env.JWT_SECRET_LEGACY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const secrets = [primary, ...legacySecrets];
  for (const secret of secrets) {
    try {
      const key = new TextEncoder().encode(secret);
      const { payload } = await jwtVerify(token, key);
      return payload as { role?: string };
    } catch {
      // Try next secret in rotation chain
    }
  }
  return null;
}

// Admin auth — bhc-admin-auth cookie + x-admin-password header.
//
// Future TOTP upgrade: add otplib + an Admins Airtable table with
// per-user TOTP secret. Picks up after launch.

const ADMIN_AUTH_COOKIE = 'bhc-admin-auth';
const PUBLIC_ADMIN_PATHS = ['/api/admin/auth', '/admin/login'];

async function isAdminAuthed(request: NextRequest): Promise<boolean> {
  // 7-day session cookie set by POST /api/admin/auth.
  // P0 fix (2026-05-30): cookie value is a signed JWT (per P3-C 2026-05-27),
  // not the literal string 'authenticated'. Verify via jose (edge-safe).
  const cookieValue = request.cookies.get(ADMIN_AUTH_COOKIE)?.value;
  if (cookieValue) {
    const claims = await verifyAdminJwt(cookieValue);
    if (claims?.role === 'admin') return true;
  }
  // Server-to-server fallback: x-admin-password header (Telegram, cron, ops).
  // Constant-time compared. Their threat profile differs from a phishable
  // human — secret lives in env var, not in a browser session.
  const adminPw = process.env.ADMIN_PASSWORD;
  if (adminPw) {
    const headerPw = request.headers.get('x-admin-password');
    if (headerPw && safeEqual(headerPw, adminPw)) return true;
  }
  return false;
}

function isAdminRoute(pathname: string): boolean {
  return (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname.startsWith('/api/admin/') ||
    pathname.startsWith('/api/referrals')
  );
}

// Vanity redirects → merch store hat collection. Cuts friction from the
// brand domain to the Shopify store. UTM tags so we can measure traffic
// source in Shopify Analytics.
const MERCH_HAT_URL = 'https://merch.buyhalfcow.com/collections/hats';
const VANITY_REDIRECTS: Record<string, string> = {
  '/hat': `${MERCH_HAT_URL}?utm_source=buyhalfcow&utm_medium=vanity&utm_campaign=hat-launch&utm_content=hat`,
  '/hats': `${MERCH_HAT_URL}?utm_source=buyhalfcow&utm_medium=vanity&utm_campaign=hat-launch&utm_content=hats`,
  '/merch': `${MERCH_HAT_URL}?utm_source=buyhalfcow&utm_medium=vanity&utm_campaign=hat-launch&utm_content=merch`,
  '/trucker': `${MERCH_HAT_URL}?utm_source=buyhalfcow&utm_medium=vanity&utm_campaign=hat-launch&utm_content=trucker`,
};

export default async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Vanity merch redirects (308 — preserve method, permanent for SEO/share).
  const vanity = VANITY_REDIRECTS[pathname];
  if (vanity) return NextResponse.redirect(vanity, 308);

  // Inquiry management: GET/PATCH/DELETE need admin (POST is public contact form)
  const isInquiryAdmin =
    pathname.startsWith('/api/inquiries') && request.method !== 'POST';

  const needsAdmin =
    (isAdminRoute(pathname) && !PUBLIC_ADMIN_PATHS.some((p) => pathname.startsWith(p))) ||
    isInquiryAdmin;

  if (needsAdmin && !(await isAdminAuthed(request))) {
    // API routes: 401 JSON. UI routes: redirect to login page.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const loginUrl = new URL('/admin/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  // Affiliate dashboard API uses its own session cookie.
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
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );

  if (process.env.NODE_ENV === 'production') {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload'
    );
  }

  return response;
}

export const config = {
  matcher: [
    // Skip Next.js internals + static asset extensions so middleware cost stays
    // at zero for images/fonts/manifest/etc.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API + tRPC routes
    '/(api|trpc)(.*)',
  ],
};
