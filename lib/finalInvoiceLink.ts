// Durable final-invoice pay-link token (the /r/f/<token> credential).
//
// Port of the deposit rail's /r/p pattern (PR #369) to the final-invoice rail.
// Before this, send-final-invoice emailed the raw Stripe-hosted Checkout URL,
// which Stripe expires after ~24h — a buyer opening the email the next day hit
// Stripe's "expired" page, and the dunning cron re-mailed the SAME dead URL
// (the Dana incident, 2026-07-20: $2,249 blocked on an expired link).
//
// The token pins exactly one referral. It carries no amount and no consumer
// identity — /r/f re-loads the referral, re-runs the money gates, and mints or
// reuses a live Stripe session at click time, so nothing money-bearing rides
// the token and nothing in the flow can expire ahead of the buyer.
//
// Kept hermetic (no lib/secrets import beyond jwt) so tests run without prod
// env — same reason lib/campaignReserve is split out.

import { signJwt, verifyJwtWithFallback } from '@/lib/jwt';
import type { VerifyResult } from '@/lib/campaignReserve';

// Distinct from every existing JWT purpose/type in the repo (campaign-reserve,
// deposit-grant, member-session…). A deposit-grant token must never open a
// final-invoice session and vice versa — /r/p and /r/f each verify their own
// purpose. Belt-and-suspenders against confused-deputy bugs.
export const FINAL_INVOICE_GRANT_PURPOSE = 'final-invoice-grant' as const;

// Outlives the dunning horizon (escalation stops buyer emails after 3 touches,
// ~9–12 days) with room for a buyer who digs the email out of a pile weeks
// later. An expired token fails safe: /r/f 302s to /ranchers, never a 500,
// and ?resend=true re-mints a fresh link.
const FINAL_INVOICE_LINK_TTL = '30d';

export interface FinalInvoiceLinkClaims {
  referralId: string;
}

export interface FinalInvoiceLinkPayload extends FinalInvoiceLinkClaims {
  purpose: typeof FINAL_INVOICE_GRANT_PURPOSE;
  iat?: number;
  exp?: number;
}

/**
 * Mint the durable final-invoice link token. Callers build
 * `${SITE_URL}/r/f/${token}` and store/email THAT instead of the raw
 * Stripe session URL.
 */
export function mintFinalInvoiceLinkToken(claims: FinalInvoiceLinkClaims): string {
  const referralId = String(claims.referralId || '').trim();
  if (!referralId) throw new Error('mintFinalInvoiceLinkToken: referralId required');
  return signJwt(
    { purpose: FINAL_INVOICE_GRANT_PURPOSE, referralId },
    { expiresIn: FINAL_INVOICE_LINK_TTL },
  );
}

/**
 * Verify a final-invoice link token. Discriminated result, never throws —
 * the /r/f route branches every failure mode to a safe 302, never a 500.
 */
export function verifyFinalInvoiceLinkToken(
  token: string | null | undefined,
): VerifyResult<FinalInvoiceLinkPayload> {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  // Bound length pre-verify — mirrors campaignReserve / auth/member/verify.
  if (token.length > 4096) return { ok: false, reason: 'invalid' };
  let decoded: any;
  try {
    decoded = verifyJwtWithFallback<any>(token);
  } catch {
    return { ok: false, reason: 'invalid' }; // expired OR tampered OR bad secret
  }
  if (!decoded || decoded.purpose !== FINAL_INVOICE_GRANT_PURPOSE) {
    return { ok: false, reason: 'wrong-purpose' };
  }
  const referralId = String(decoded.referralId || '').trim();
  if (!referralId) return { ok: false, reason: 'invalid' };
  return { ok: true, payload: { purpose: FINAL_INVOICE_GRANT_PURPOSE, referralId } };
}
