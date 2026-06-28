import { timingSafeEqual } from 'crypto';
import { CRON_SECRET } from '@/lib/secrets';

// Fail-closed cron authentication.
//
// History: most crons used to wrap their auth check in `if (cronSecret) {...}`,
// reading `process.env.CRON_SECRET` directly. If CRON_SECRET was ever unset or
// blank the entire check was SKIPPED — the route ran for anyone. Several also
// accepted the secret via `?secret=`, which leaked it into Vercel access logs.
//
// This helper closes both holes:
//   - CRON_SECRET is imported from '@/lib/secrets', which calls requireEnv at
//     module load. A missing/blank value crashes the import (fail-loud) instead
//     of silently disabling auth.
//   - The Authorization Bearer check is UNCONDITIONAL and constant-time. There
//     is no `?secret=` fallback.
//
// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` on every invocation.

/**
 * Constant-time string comparison that never short-circuits on length.
 * Returns false (instead of throwing) for any mismatch.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Compare against self to keep timing uniform, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Returns true iff the request carries the correct `Authorization: Bearer <CRON_SECRET>`.
 * Pure with respect to its input — no env reads beyond the import-time CRON_SECRET.
 */
export function isAuthorizedCron(request: Request): boolean {
  const authHeader = request.headers.get('authorization');
  if (!authHeader) return false;
  return safeEqual(authHeader, `Bearer ${CRON_SECRET}`);
}

/**
 * Guard for cron route handlers. Returns a 401 Response when the request is not
 * an authorized cron call, or null when the caller may proceed.
 *
 * Usage:
 *   const denied = requireCron(request);
 *   if (denied) return denied;
 */
export function requireCron(request: Request): Response | null {
  if (isAuthorizedCron(request)) return null;
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}
