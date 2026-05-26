import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

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

// Auth Phase 0 — Clerk for admin surface only.
//
// Browser admin access: requires a Clerk session AND email in ADMIN_EMAILS
// allowlist. TOTP 2FA enforced via Clerk Dashboard → Multi-factor.
//
// Server-to-server admin access: x-admin-password header still works
// (Telegram bot, cron scripts, ops curl). The DEV-only ?password= query
// param is GONE — that surface was already disabled in prod and now
// removed entirely.
//
// Buyer + rancher auth UNCHANGED — see lib/auth-* and app/api/auth/*.
// They migrate to Clerk in Phase 1/2.

const isAdminRoute = createRouteMatcher([
  '/admin(.*)',
  '/api/admin/(.*)',
  '/api/referrals/(.*)',
  '/api/inquiries/(.*)',
]);

// Public admin paths that DON'T require Clerk session.
// /api/admin/auth returns 410 Gone with migration guidance.
const PUBLIC_ADMIN_PATHS = ['/api/admin/auth', '/admin/login'];

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

export default clerkMiddleware(async (auth, req) => {
  const { pathname } = req.nextUrl;

  // Vanity merch redirects (308 — preserve method, permanent for SEO/share).
  const vanity = VANITY_REDIRECTS[pathname];
  if (vanity) return NextResponse.redirect(vanity, 308);

  // Inquiry management: GET/PATCH/DELETE need admin (POST is public contact form)
  const isInquiryAdmin =
    pathname.startsWith('/api/inquiries') && req.method !== 'POST';

  const needsAdmin =
    (isAdminRoute(req) && !PUBLIC_ADMIN_PATHS.some((p) => pathname.startsWith(p))) ||
    isInquiryAdmin;

  if (needsAdmin) {
    // Server-to-server fallback: x-admin-password header (Telegram, cron, ops).
    // Their threat profile differs from a phishable human — secret in env var.
    const adminPw = process.env.ADMIN_PASSWORD;
    const headerPw = req.headers.get('x-admin-password');
    const isServerAuth = !!(adminPw && headerPw && safeEqual(headerPw, adminPw));

    if (!isServerAuth) {
      const { userId, sessionClaims } = await auth();
      if (!userId) {
        // API routes: 401 JSON. UI routes: redirect to Clerk sign-in.
        if (pathname.startsWith('/api/')) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const loginUrl = new URL('/admin/login', req.url);
        return NextResponse.redirect(loginUrl);
      }

      // Email allowlist — only emails in ADMIN_EMAILS env can pass.
      //
      // FAIL-CLOSED in production when empty: previously empty = any signed-in
      // Clerk user could reach /admin. Clerk allows public sign-ups unless the
      // Dashboard restricts them, so empty allowlist was an unbounded prod
      // exposure. Now an empty list in production rejects every browser request.
      // In dev (NODE_ENV !== 'production') empty list is still permissive so
      // local testing works without Clerk Dashboard config.
      const userEmail = String(
        (sessionClaims as Record<string, unknown>)?.email ?? ''
      ).toLowerCase();
      const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      const isProd = process.env.NODE_ENV === 'production';
      if (ADMIN_EMAILS.length === 0 && isProd) {
        if (pathname.startsWith('/api/')) {
          return NextResponse.json(
            { error: 'Admin allowlist not configured' },
            { status: 403 }
          );
        }
        return NextResponse.redirect(new URL('/?reason=admin-misconfig', req.url));
      }
      if (ADMIN_EMAILS.length > 0 && !ADMIN_EMAILS.includes(userEmail)) {
        if (pathname.startsWith('/api/')) {
          return NextResponse.json(
            { error: 'Not authorized as admin' },
            { status: 403 }
          );
        }
        return NextResponse.redirect(new URL('/?reason=not-admin', req.url));
      }
    }
  }

  // Affiliate dashboard API still uses its own cookie (out of Phase 0 scope).
  if (pathname.startsWith('/api/affiliate/')) {
    const affiliateCookie = req.cookies.get('bhc-affiliate-auth');
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
});

export const config = {
  matcher: [
    // Skip Next.js internals + static asset extensions (Clerk canonical pattern).
    // Lookahead excludes the file types we never want clerkMiddleware running on
    // so request-handling cost stays at zero for images/fonts/manifest/etc.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Clerk's auto-proxy path for OAuth callbacks + session sync. REQUIRED —
    // without this, Clerk SSO + magic-link redirects 404 in production.
    '/__clerk/(.*)',
    // Always run for API + tRPC routes
    '/(api|trpc)(.*)',
  ],
};
