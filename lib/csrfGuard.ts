// lib/csrfGuard.ts
//
// ORIGIN ALLOWLIST — defense-in-depth CSRF guard for cookie-auth POST routes.
//
// Why: SameSite=lax cookies protect against cross-origin fetch but NOT top-
// level form POSTs from a malicious site. An attacker page with
//   <form action="https://buyhalfcow.com/api/checkout/deposit" method="POST">
// can submit and the buyer-session cookie WILL ride along. This guard
// rejects any state-changing POST whose Origin header isn't on the
// allowlist.
//
// Apply to: /api/checkout/deposit, /api/member/*, /api/rancher/* (any
// cookie-auth POST that mutates state or moves money).
//
// Do NOT apply to: webhook handlers (they have signature verification),
// public form posts that intentionally accept cross-origin traffic (none
// exist today — /api/consumers is same-origin only by design).

import { NextResponse } from 'next/server';

const ALLOWED_ORIGINS = new Set<string>([
  'https://buyhalfcow.com',
  'https://www.buyhalfcow.com',
  // Vercel preview URLs follow bhc-*.vercel.app pattern; allow per-deploy
  // testing without bypassing prod gate. Strict allowlist still applies
  // for prod traffic.
]);

const PREVIEW_HOSTNAME_REGEX = /^https:\/\/bhc-[a-z0-9-]+-benibeauchman-3168s-projects\.vercel\.app$/i;

export interface CsrfGuardResult {
  ok: boolean;
  /** When ok=false, a NextResponse to return immediately from the handler. */
  response?: NextResponse;
}

/**
 * Verify the request's Origin header is on the allowlist. Localhost dev
 * (no Origin set on same-origin requests) passes by default — Next.js
 * doesn't send Origin for same-origin POSTs in some browsers.
 *
 * Strict behavior:
 *   - Origin present + on allowlist → ok
 *   - Origin present + NOT on allowlist → reject
 *   - Origin absent → fall back to Referer (also allowlisted)
 *   - Both absent → ok (same-origin POST in browsers that omit Origin)
 *
 * Failure mode is JSON 403, NOT redirect, so APIs return structured error.
 */
export function checkOriginGuard(request: Request): CsrfGuardResult {
  const origin = request.headers.get('origin') || '';
  const referer = request.headers.get('referer') || '';

  // Allow if Origin is on the allowlist OR matches the preview-deploy pattern.
  if (origin) {
    if (ALLOWED_ORIGINS.has(origin) || PREVIEW_HOSTNAME_REGEX.test(origin)) {
      return { ok: true };
    }
    // Origin present but not allowlisted = definite cross-origin attempt.
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Cross-origin request not allowed' },
        { status: 403 },
      ),
    };
  }

  // No Origin header — check Referer as fallback. Some browsers omit Origin
  // on top-level POSTs but send Referer.
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (ALLOWED_ORIGINS.has(refOrigin) || PREVIEW_HOSTNAME_REGEX.test(refOrigin)) {
        return { ok: true };
      }
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'Cross-origin request not allowed' },
          { status: 403 },
        ),
      };
    } catch {
      // Malformed Referer — fall through to permissive default below.
    }
  }

  // Neither Origin nor Referer present. Same-origin browsers may omit
  // both on some request types. Allow by default; downstream auth gates
  // are still in place. If we get scraper abuse, tighten to reject.
  return { ok: true };
}
