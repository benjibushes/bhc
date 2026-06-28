// Pure buyer member-session token minting. Split out of buyerAuth.ts so it can
// be unit-tested without pulling in lib/secrets (which throws at module load
// when prod env vars like ADMIN_PASSWORD are absent). Depends only on the
// hermetic signJwt helper (reads process.env.JWT_SECRET directly).

import { signJwt } from '@/lib/jwt';

export interface BuyerSessionClaims {
  consumerId: string;
  email: string;
  name?: string;
  state?: string;
}

/**
 * Mint a member-session JWT identical to the one /api/qualify + /api/warmup/engage
 * issue (app/api/qualify/route.ts:498-508). resolveBuyerSession reads it back.
 */
export function mintBuyerSessionToken(claims: BuyerSessionClaims): string {
  return signJwt(
    {
      type: 'member-session',
      consumerId: claims.consumerId,
      email: (claims.email || '').trim().toLowerCase(),
      state: claims.state || '',
      name: claims.name || '',
    },
    { expiresIn: '30d' },
  );
}
