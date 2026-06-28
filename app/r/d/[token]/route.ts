// GET /r/d/<token> — campaign 1-tap deposit link.
//
// A KNOWN buyer taps a personalized link from a campaign email/SMS and lands
// straight on the deposit checkout for a specific rancher + cut — skipping email
// re-entry AND the returning-buyer magic-link wall on /api/checkout/reserve.
//
// Path note: lives at /r/d/<token> (not /r/<token>) because /r/[code] is already
// the affiliate landing PAGE — two different dynamic segment names can't share a
// path level in Next, and a money path needs a ROUTE HANDLER (to set an httpOnly
// cookie + 302), not a server page. The static `d` child segment matches before
// the dynamic `[code]` sibling, so the two coexist cleanly.
//
// Flow:
//   1. Verify the campaign-reserve token (signed by us, ~30d). Reject expired /
//      tampered / wrong-purpose.
//   2. Find-or-create the deposit-intent referral pinning the token's buyer to
//      the token's rancher (REUSES the reserve path's record shape + capacity
//      hold via lib/campaignReferral).
//   3. Mint a referral-SCOPED deposit-grant cookie (NOT a member-session — a
//      forwarded link must never hand over /member) and 302 to the deposit page
//      with the cut pre-selected.
//   4. ANY failure → 302 to the rancher's public page (or /ranchers), NEVER 500.
//
// This is a GET a browser navigates to directly from an email/SMS, so there's no
// Origin/Referer to guard (checkOriginGuard is for state-changing POSTs and a
// nav GET passes it anyway). Mirrors the established GET-token→set-cookie→302
// shape of app/api/auth/member/verify + app/api/warmup/engage.

import { NextResponse } from 'next/server';
import {
  verifyCampaignReserveToken,
  mintDepositGrantToken,
  decideCampaignRedirect,
  rancherPublicPath,
} from '@/lib/campaignReserve';
import { findOrCreateCampaignReferral } from '@/lib/campaignReferral';
import { setDepositGrantCookie } from '@/lib/buyerAuth';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

function redirectBaseFrom(req: Request): string {
  try {
    return new URL(req.url).origin;
  } catch {
    return SITE_URL;
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const base = redirectBaseFrom(req);
  // Generic safety net: if anything below throws unexpectedly, send the buyer to
  // the storefront rather than a 500.
  const safeFallback = (slug?: string) =>
    NextResponse.redirect(`${base}${rancherPublicPath(slug || '')}`, 302);

  let token = '';
  try {
    ({ token } = await params);
  } catch {
    return safeFallback();
  }

  // Light per-IP rate limit. This GET creates/finds a referral + bumps capacity,
  // so it's the abuse surface even though each hit still needs a valid signed
  // token. 10/min/IP is far above any human tap rate. rateLimit fails OPEN
  // (Redis absent/erroring → ok:true), so a real buyer is never wrongly bounced;
  // this only caps a genuine burst. On a hit we 302 to the storefront rather
  // than 500/429 — the browser is the only caller and expects a redirect.
  const ip = getRequestIp(req);
  const rl = await rateLimit(`r-deposit-link:${ip}`, { requests: 10, window: '1m' });
  if (!rl.ok) {
    return safeFallback();
  }

  // 1) Verify the campaign token. On bad/expired/tampered/wrong-purpose we have
  //    no trusted slug, so fall back to the generic storefront.
  const verified = verifyCampaignReserveToken(token);
  if (!verified.ok) {
    return safeFallback();
  }

  // 2) Find-or-create the buyer's referral pinned to this rancher. Never throws.
  let resolved: { referralId: string; created: boolean; rancher: any } | null = null;
  try {
    const r = await findOrCreateCampaignReferral({
      consumerId: verified.payload.consumerId,
      rancherSlug: verified.payload.rancherSlug,
      cut: verified.payload.cut,
    });
    if (r.ok) resolved = { referralId: r.referralId, created: r.created, rancher: r.rancher };
  } catch {
    resolved = null;
  }

  // 3) Decide the redirect (pure). Valid token + resolved referral → deposit;
  //    else → this rancher's public page.
  const decision = decideCampaignRedirect(
    verified,
    resolved ? { referralId: resolved.referralId } : null,
    verified.payload.rancherSlug,
  );

  if (decision.kind === 'fallback') {
    return NextResponse.redirect(`${base}${decision.path}`, 302);
  }

  // 4) Mint the referral-scoped grant + set the cookie on the redirect response,
  //    then send the browser to the deposit page (cut pre-selected). The grant
  //    authorizes ONLY this referral's deposit/preferences/thread — never /member.
  const res = NextResponse.redirect(`${base}${decision.path}`, 302);
  try {
    const grant = mintDepositGrantToken({
      consumerId: decision.consumerId,
      referralId: decision.referralId,
    });
    setDepositGrantCookie(res, grant);
  } catch {
    // If grant minting somehow fails, still land them on the deposit page — a
    // logged-in buyer's member cookie may carry them; otherwise the page shows
    // the auth-required state rather than 500ing.
    return NextResponse.redirect(`${base}${decision.path}`, 302);
  }
  return res;
}
