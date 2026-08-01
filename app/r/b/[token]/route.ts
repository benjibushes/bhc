// GET /r/b/<token> — BROKER 1-tap deposit link.
//
// Ben sells a represented ranch on the phone and texts this link. The buyer
// taps it and lands straight on the broker checkout for that ranch + cut.
//
// Sibling of /r/d (the Connect campaign link) and deliberately a SEPARATE path
// with a SEPARATE token purpose: the two rails charge under different money
// models, so a link for one must never redeem on the other. See
// lib/campaignReserve BROKER_RESERVE_PURPOSE.
//
// Flow:
//   1. Verify the broker-reserve token (signed by us, 30d).
//   2. Find-or-create the referral pinning this buyer to this represented
//      rancher, re-checking the broker rail + the money gates at tap time.
//   3. Mint a referral-SCOPED deposit-grant cookie — the SAME scoped grant the
//      Connect rail uses, never a member session, so a forwarded link can at
//      worst pay this one deposit and can never reach /member.
//   4. ANY failure → 302 to /ranchers, NEVER a 500. A broker ranch has no
//      public page to fall back to (that is the point of the rail), so the
//      generic storefront is the only honest destination.

import { NextResponse } from 'next/server';
import {
  verifyBrokerReserveToken,
  mintDepositGrantToken,
  brokerDepositPathFor,
} from '@/lib/campaignReserve';
import { findOrCreateBrokerReferral } from '@/lib/brokerReferral';
import { setDepositGrantCookie } from '@/lib/buyerAuth';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

function redirectBaseFrom(req: Request): string {
  try {
    return new URL(req.url).origin;
  } catch {
    return SITE_URL;
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const base = redirectBaseFrom(req);
  const safeFallback = () => NextResponse.redirect(`${base}/ranchers`, 302);

  let token = '';
  try {
    ({ token } = await params);
  } catch {
    return safeFallback();
  }

  // Light per-IP rate limit — this GET creates a referral, so it's the abuse
  // surface even though every hit needs a valid signed token. rateLimit fails
  // OPEN, so a real buyer is never wrongly bounced.
  const rl = await rateLimit(`r-broker-link:${getRequestIp(req)}`, { requests: 10, window: '1m' });
  if (!rl.ok) return safeFallback();

  const verified = verifyBrokerReserveToken(token);
  if (!verified.ok) return safeFallback();

  let resolved: { referralId: string } | null = null;
  try {
    const r = await findOrCreateBrokerReferral({
      consumerId: verified.payload.consumerId,
      rancherId: verified.payload.rancherId,
      cut: verified.payload.cut,
    });
    if (r.ok) resolved = { referralId: r.referralId };
  } catch {
    resolved = null;
  }
  // Fail closed: an ineligible ranch, a rail flip since the link was minted, or
  // any I/O fault all land here rather than on a checkout we can't price.
  if (!resolved) return safeFallback();

  const path = brokerDepositPathFor(resolved.referralId, verified.payload.cut);
  const res = NextResponse.redirect(`${base}${path}`, 302);
  try {
    setDepositGrantCookie(
      res,
      mintDepositGrantToken({
        consumerId: verified.payload.consumerId,
        referralId: resolved.referralId,
      }),
    );
  } catch {
    // Grant minting failed — still land them on the page. A logged-in buyer's
    // member cookie may carry them; otherwise the page shows the auth-required
    // state rather than 500ing.
    return NextResponse.redirect(`${base}${path}`, 302);
  }
  return res;
}
