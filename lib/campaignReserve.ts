// Campaign 1-tap deposit links — pure token + decision logic.
//
// A campaign email/SMS sends a KNOWN buyer a personalized link they tap to land
// straight on the deposit checkout for a specific rancher + cut, skipping the
// email re-entry AND the returning-buyer magic-link wall on /api/checkout/reserve.
//
// SECURITY MODEL — read this before touching anything here.
//
// There are TWO distinct tokens, deliberately split:
//
//  1) CAMPAIGN-RESERVE token  (purpose:'campaign-reserve', ~30-day exp)
//     - The sender mints one per buyer and embeds it in the link
//       (/r/d/<token>). It names {consumerId, rancherSlug, cut}.
//     - It is the BYPASS credential for the magic-link wall: the wall exists to
//       stop someone adopting an UNVERIFIED email's identity. A token WE signed
//       and emailed to that buyer's own address IS that verification, so — and
//       ONLY this token — may skip the wall. It does NOT itself grant any
//       session; the /r route exchanges it (after re-resolving the buyer's own
//       referral) for the scoped grant below.
//
//  2) DEPOSIT-GRANT token  (purpose:'deposit-grant', short exp)
//     - Pins {consumerId, referralId}. Set as the httpOnly `bhc-deposit-grant`
//       cookie by the /r route. The deposit-flow routes accept it as a
//       REFERRAL-SCOPED alternative to the full member-session, but ONLY for the
//       one referralId it names (resolveDepositGrant checks refId match).
//     - It is NOT a member-session. /member, /api/member/*, reorder,
//       upgrade-intent etc. all gate on resolveBuyerSession (the member-session
//       cookie) and never consult this grant — so a FORWARDED campaign link can,
//       at worst, let the forwardee see/pay ONE deposit checkout for that one
//       referral. It can never hand them the buyer's dashboard, order history, or
//       the ability to start new orders. That is the containment boundary.
//
// Why a separate cookie instead of minting bhc-member-auth: the member-session
// cookie is the SAME cookie that unlocks /member (lib/buyerAuth.ts +
// MemberAuthGuard). Minting it from a forwardable link would hand a forwardee
// the buyer's whole account. The scoped grant cannot.
//
// Hermetic: depends only on signJwt / verifyJwtWithFallback (which read
// process.env.JWT_SECRET directly), never lib/secrets — so this module is
// unit-testable without prod env (same reason lib/buyerSession + lib/reserveDeposit
// are split out).

import { signJwt, verifyJwtWithFallback } from '@/lib/jwt';
import { CUT_LABELS, type Cut } from '@/lib/reserveDeposit';

// ---------------------------------------------------------------------------
// Token purposes — kept distinct from every existing JWT `type`/`purpose` value
// in the repo. We use `purpose:` (not `type:`) so these can never be mistaken
// for a `type:'member-session'` cookie by resolveBuyerSession (which keys on
// `type`). Belt-and-suspenders against confused-deputy bugs.
// ---------------------------------------------------------------------------
export const CAMPAIGN_RESERVE_PURPOSE = 'campaign-reserve' as const;
export const DEPOSIT_GRANT_PURPOSE = 'deposit-grant' as const;

export const DEPOSIT_GRANT_COOKIE = 'bhc-deposit-grant';

// Campaign links live ~30 days (a full nurture window). The grant is short —
// it only needs to outlive the single checkout hop, but we give it a comfortable
// session-length so a buyer who lingers on the page / comes back same-day from
// the same device still completes. It is referral-scoped regardless of TTL.
const CAMPAIGN_RESERVE_TTL = '30d';
const DEPOSIT_GRANT_TTL = '2d';

// ---------------------------------------------------------------------------
// Campaign-reserve token (the link credential).
// ---------------------------------------------------------------------------

export interface CampaignReserveClaims {
  consumerId: string;
  rancherSlug: string;
  cut: Cut;
}

export interface CampaignReservePayload extends CampaignReserveClaims {
  purpose: typeof CAMPAIGN_RESERVE_PURPOSE;
  iat?: number;
  exp?: number;
}

/**
 * Mint the per-buyer campaign link token. The sender calls this once per buyer
 * to build `{link}` = `${SITE_URL}/r/d/${token}`.
 *
 * Throws on a missing/empty field so a malformed broadcast can't ship links that
 * resolve to nothing.
 */
export function mintCampaignReserveToken(claims: CampaignReserveClaims): string {
  const consumerId = String(claims.consumerId || '').trim();
  const rancherSlug = String(claims.rancherSlug || '').trim();
  const cut = String(claims.cut || '').trim().toLowerCase() as Cut;
  if (!consumerId) throw new Error('mintCampaignReserveToken: consumerId required');
  if (!rancherSlug) throw new Error('mintCampaignReserveToken: rancherSlug required');
  if (!CUT_LABELS[cut]) throw new Error('mintCampaignReserveToken: cut must be quarter|half|whole');
  return signJwt(
    { purpose: CAMPAIGN_RESERVE_PURPOSE, consumerId, rancherSlug, cut },
    { expiresIn: CAMPAIGN_RESERVE_TTL },
  );
}

export type VerifyResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: 'missing' | 'invalid' | 'wrong-purpose' };

/**
 * Verify a campaign-reserve token. Returns a discriminated result rather than
 * throwing so the /r route can branch to a SAFE FALLBACK (never a 500) on every
 * failure mode: missing, expired, tampered, or a token of the wrong purpose
 * (e.g. someone pasting a member-login JWT into the campaign path).
 */
export function verifyCampaignReserveToken(token: string | null | undefined): VerifyResult<CampaignReservePayload> {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  // Bound length pre-verify — jwt.verify on a multi-KB payload still burns CPU.
  // Standard JWTs are <1KB; 4KB is generous. Mirrors auth/member/verify.
  if (token.length > 4096) return { ok: false, reason: 'invalid' };
  let decoded: any;
  try {
    decoded = verifyJwtWithFallback<any>(token);
  } catch {
    return { ok: false, reason: 'invalid' }; // expired OR tampered OR bad secret
  }
  if (!decoded || decoded.purpose !== CAMPAIGN_RESERVE_PURPOSE) {
    return { ok: false, reason: 'wrong-purpose' };
  }
  const consumerId = String(decoded.consumerId || '').trim();
  const rancherSlug = String(decoded.rancherSlug || '').trim();
  const cut = String(decoded.cut || '').trim().toLowerCase() as Cut;
  if (!consumerId || !rancherSlug || !CUT_LABELS[cut]) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, payload: { purpose: CAMPAIGN_RESERVE_PURPOSE, consumerId, rancherSlug, cut } };
}

// ---------------------------------------------------------------------------
// Deposit-grant token (the scoped capability cookie value).
// ---------------------------------------------------------------------------

export interface DepositGrantClaims {
  consumerId: string;
  referralId: string;
}

export interface DepositGrantPayload extends DepositGrantClaims {
  purpose: typeof DEPOSIT_GRANT_PURPOSE;
  iat?: number;
  exp?: number;
}

/**
 * Mint the referral-scoped deposit grant. Set by the /r route as the
 * `bhc-deposit-grant` cookie after it has resolved the buyer's OWN referral.
 * Pins both consumerId and referralId so it authorizes exactly one checkout.
 */
export function mintDepositGrantToken(claims: DepositGrantClaims): string {
  const consumerId = String(claims.consumerId || '').trim();
  const referralId = String(claims.referralId || '').trim();
  if (!consumerId) throw new Error('mintDepositGrantToken: consumerId required');
  if (!referralId) throw new Error('mintDepositGrantToken: referralId required');
  return signJwt(
    { purpose: DEPOSIT_GRANT_PURPOSE, consumerId, referralId },
    { expiresIn: DEPOSIT_GRANT_TTL },
  );
}

/**
 * Verify a deposit-grant token value (cookie). SCOPED: if `expectReferralId` is
 * supplied, the grant must name that exact referral or it's rejected — this is
 * what keeps the capability pinned to one checkout and stops a grant for
 * referral A authorizing actions on referral B.
 */
export function verifyDepositGrantToken(
  token: string | null | undefined,
  expectReferralId?: string,
): VerifyResult<DepositGrantPayload> {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  if (token.length > 4096) return { ok: false, reason: 'invalid' };
  let decoded: any;
  try {
    decoded = verifyJwtWithFallback<any>(token);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!decoded || decoded.purpose !== DEPOSIT_GRANT_PURPOSE) {
    return { ok: false, reason: 'wrong-purpose' };
  }
  const consumerId = String(decoded.consumerId || '').trim();
  const referralId = String(decoded.referralId || '').trim();
  if (!consumerId || !referralId) return { ok: false, reason: 'invalid' };
  if (expectReferralId && referralId !== String(expectReferralId).trim()) {
    // Grant is valid but for a DIFFERENT referral — out of scope.
    return { ok: false, reason: 'wrong-purpose' };
  }
  return { ok: true, payload: { purpose: DEPOSIT_GRANT_PURPOSE, consumerId, referralId } };
}

/**
 * Grant↔thread scope predicate — pure, unit-tested in campaignReserve.test.ts.
 *
 * The deposit grant is REFERRAL-scoped but the thread message route is
 * THREAD-scoped, so the route resolves the thread's `Referral` link and asks
 * this predicate whether the grant's referralId names exactly that referral.
 * STRICT: authorizes ONLY on an exact string match against one of the thread's
 * Referral link ids. Empty grant id, missing/non-array link cell, non-string
 * members, or substring overlap all refuse. The grant id is trimmed (cookie
 * hygiene); link ids are NOT (a padded link id is data corruption, not a match).
 */
export function depositGrantAuthorizesThread(
  grantReferralId: string,
  threadReferralLinkIds: unknown,
): boolean {
  const gid = String(grantReferralId || '').trim();
  if (!gid) return false;
  if (!Array.isArray(threadReferralLinkIds)) return false;
  return threadReferralLinkIds.some((id) => typeof id === 'string' && id === gid);
}

// ---------------------------------------------------------------------------
// Pure redirect decision — the testable core of the /r route. Given a verify
// result + the referral that the route resolved (or null on any I/O failure),
// decide where the browser goes. Never throws; always yields a relative path.
// ---------------------------------------------------------------------------

import { depositPathFor } from '@/lib/reserveDeposit';

/** Public fallback page for a rancher slug (the storefront). */
export function rancherPublicPath(rancherSlug: string): string {
  const safe = String(rancherSlug || '').trim();
  return safe ? `/ranchers/${safe}` : '/ranchers';
}

export type CampaignRedirectDecision =
  | { kind: 'deposit'; path: string; referralId: string; consumerId: string }
  | { kind: 'fallback'; path: string };

/**
 * Decide the redirect for a /r/d/<token> hit.
 *
 *  - Valid token + a resolved referral pinned to the buyer → deposit page
 *    (cut pre-selected), and the caller sets the deposit-grant cookie.
 *  - Anything else (bad/expired/wrong-purpose token, OR referral resolution
 *    failed) → the rancher's public page if we know the slug, else /ranchers.
 *
 * `slugForFallback` is passed separately so a wrong-purpose token (where we
 * never trust its claims) can still fall back to a generic page, while a valid
 * token falls back to its own rancher's page.
 */
export function decideCampaignRedirect(
  verify: VerifyResult<CampaignReservePayload>,
  resolved: { referralId: string } | null,
  slugForFallback?: string,
): CampaignRedirectDecision {
  if (!verify.ok) {
    return { kind: 'fallback', path: rancherPublicPath(slugForFallback || '') };
  }
  if (!resolved || !resolved.referralId) {
    return { kind: 'fallback', path: rancherPublicPath(verify.payload.rancherSlug) };
  }
  return {
    kind: 'deposit',
    path: depositPathFor(resolved.referralId, verify.payload.cut),
    referralId: resolved.referralId,
    consumerId: verify.payload.consumerId,
  };
}
