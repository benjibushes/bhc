// Centralized, validated environment secrets.
//
// Every auth-critical secret (JWT_SECRET, ADMIN_PASSWORD, CRON_SECRET) was
// being read individually with `process.env.X || 'fallback-string'` across
// 30+ files. The fallbacks were development conveniences that became
// security holes:
//
//   1. If any env var got accidentally unset on deploy (mistyped name,
//      Vercel env var deleted, staging copy missing the var), every file
//      silently fell back to a hardcoded string. Anyone who knew that string
//      could forge JWTs / log into admin / trigger crons.
//
//   2. The `'changeme123'` admin fallback and `'bhc-member-secret-change-me'`
//      JWT fallback were grep-able from the public GitHub repo.
//
// Fix: import from this module instead. If a required secret is missing,
// the import itself throws — failing the whole route loudly with a clear
// error in logs. No silent fallbacks, no insecure defaults.
//
// Usage:
//   import { JWT_SECRET, ADMIN_PASSWORD, CRON_SECRET } from '@/lib/secrets';
//
// Tests / local dev: set the vars in .env.local. The fail-fast behavior
// makes missing config visible immediately, not after a security incident.

function requireEnv(name: string, opts?: { allowEmptyInDev?: boolean }): string {
  const value = process.env[name];
  if (value && value.length > 0) return value;
  // In production, ALWAYS throw. In dev, throw unless explicitly opted out.
  // (No env opts out of JWT_SECRET — even local dev needs deterministic auth.)
  if (process.env.NODE_ENV === 'production' || !opts?.allowEmptyInDev) {
    throw new Error(
      `Required env var ${name} is not set. ` +
      `Add it to .env.local for development or set it in Vercel for production. ` +
      `No insecure fallback is provided — see lib/secrets.ts.`
    );
  }
  return '';
}

// JWT signing key for member/rancher/affiliate sessions + warmup engage tokens
// + check-in tokens + activate/decline tokens. Without this, every signed link
// in every email becomes forgeable. Required in all environments.
export const JWT_SECRET = requireEnv('JWT_SECRET');

// Admin login password (operator UI gate). Required.
export const ADMIN_PASSWORD = requireEnv('ADMIN_PASSWORD');

// Cron auth — Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Required
// to prevent anyone who guesses cron URLs from triggering expensive jobs (mass
// emails, bulk DB writes).
export const CRON_SECRET = requireEnv('CRON_SECRET');

// Internal-API secret for service-to-service calls (e.g., /api/consumers
// calling /api/matching/suggest). Optional — if absent, internal callers
// fall back to admin password / member session for auth.
export const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';
