// Centralized JWT sign/verify with multi-secret rotation grace.
//
// Why this exists:
// Rotating JWT_SECRET in prod nukes every outstanding signed token in the same
// instant — ~1500 buyer session cookies (bhc-member-auth), all rancher and
// affiliate session cookies, every magic-login link in flight, every warmup
// engage / activate / decline / sign-agreement / setup link sitting in someone's
// inbox. Previously the rotation grace pattern lived ONLY in
// app/api/rancher/{activate,decline}/route.ts (added 2026-04-29 for the
// pilot-pitch broadcast). Every other verify site called jwt.verify(token, JWT_SECRET)
// directly, so rotation was effectively impossible without scheduled downtime.
//
// This helper centralizes the pattern: try PRIMARY first, then each comma-
// separated secret in JWT_SECRET_LEGACY in turn. Existing tokens keep working
// until they expire naturally; new tokens get signed with PRIMARY only.
//
// Usage:
//   import { verifyJwtWithFallback, signJwt } from '@/lib/jwt';
//   const decoded = verifyJwtWithFallback<MyClaims>(token);
//   const token = signJwt({ ... }, { expiresIn: '7d' });
//
// JWT_SECRET_LEGACY format: comma-separated list of prior secrets.
//   Example: JWT_SECRET_LEGACY="old_secret_1,old_secret_2"
// Checked in order after PRIMARY fails. Empty / unset = no fallback.
//
// Replumbed call sites (P3-C, 2026-05-27):
//   - lib/adminAuth.ts            requireAdmin (admin cookie)
//   - app/api/auth/member/verify   member magic link (POST + GET)
//   - app/api/auth/rancher/verify  rancher magic link
//   - app/api/auth/affiliate/verify affiliate magic link
//
// TODO — remaining sites still calling jwt.verify(token, JWT_SECRET) directly
// (these should be migrated in a follow-up to give them the same rotation
// grace; they're lower-stakes today but each one breaks on rotation):
//   - app/api/auth/affiliate/session/route.ts        (affiliate session cookie)
//   - app/api/affiliate/dashboard/route.ts           (affiliate session cookie)
//   - app/api/buyer-pulse/route.ts                   (one-click pulse link)
//   - app/api/unsubscribe/route.ts                   (unsubscribe token, x2)
//   - app/api/backfill/validate-token/route.ts       (backfill flow)
//   - app/api/backfill/update-profile/route.ts       (backfill flow)
//   - app/api/rancher/remove/route.ts                (rancher self-remove)
//   - app/api/rancher/checkin-response/route.ts      (check-in tokens)
//   - app/api/rancher/setup/route.ts                 (setup wizard)
//   - app/api/rancher/setup/auto-about/route.ts      (setup wizard)
//   - app/api/rancher/setup/request-agreement/route.ts (setup wizard)
//   - app/api/rancher/quick-action/route.ts          (telegram quick actions)
//   - app/api/warmup/engage/route.ts                 (warmup engage tokens)
//   - app/api/ranchers/sign-agreement/route.ts       (agreement signature)
//   - app/api/reviews/submit/route.ts                (review submit tokens)
//   - lib/buyerAuth.ts                               (buyer session cookie)
//   - lib/rancherAuth.ts                             (rancher session cookie)
//   - app/api/rancher/activate/route.ts              (has inline fallback today — collapse onto helper)
//   - app/api/rancher/decline/route.ts               (has inline fallback today — collapse onto helper)

import jwt from 'jsonwebtoken';

const PRIMARY = process.env.JWT_SECRET || '';
// JWT_SECRET_LEGACY = comma-separated list of prior secrets for grace window.
// Format: "old_secret_1,old_secret_2" — checked in order after PRIMARY fails.
const LEGACY = (process.env.JWT_SECRET_LEGACY || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

export function verifyJwtWithFallback<T extends object = any>(
  token: string,
  options?: jwt.VerifyOptions,
): T {
  if (!PRIMARY) throw new Error('JWT_SECRET unset');
  try {
    return jwt.verify(token, PRIMARY, options) as T;
  } catch (primaryErr: any) {
    for (const legacy of LEGACY) {
      try {
        return jwt.verify(token, legacy, options) as T;
      } catch { /* try next */ }
    }
    throw primaryErr;
  }
}

export function signJwt(payload: object, options?: jwt.SignOptions): string {
  if (!PRIMARY) throw new Error('JWT_SECRET unset');
  return jwt.sign(payload, PRIMARY, options);
}
