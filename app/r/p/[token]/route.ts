// GET /r/p/<token> — durable pay link for an EXISTING referral's deposit.
//
// The link the rancher "Request Deposit" + admin deposit-invoice emails carry
// (2026-07-14 fix). Before this, those emails carried the raw Stripe-hosted
// Checkout Session URL, which Stripe expires after ~24h — a buyer opening the
// email the next day hit Stripe's "expired" error page, and re-requests handed
// back the same dead URL. This link never expires in practice (~30d signed
// token, re-issuable): the deposit page mints a FRESH Stripe session at
// pay-click, so there is no expiring artifact anywhere in the flow.
//
// Sibling of /r/d/<token> (campaign 1-tap, find-or-create referral). This one
// is strictly narrower: the token IS a deposit grant pinning
// {consumerId, referralId} — no record creation, no capacity bump. We verify,
// re-mint a fresh SHORT-ttl grant cookie (the URL token's long TTL never rides
// the cookie), and 302 to the on-domain deposit page with the requested cut
// pre-selected from the referral's Order Type.
//
// ANY failure → 302 to /ranchers, never a 500 — this is a nav GET from an
// email client.

import { NextResponse } from 'next/server';
import { verifyDepositGrantToken, mintDepositGrantToken } from '@/lib/campaignReserve';
import { setDepositGrantCookie } from '@/lib/buyerAuth';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

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

  // Light per-IP limit — mirrors /r/d. This GET only reads one record + sets a
  // cookie, but it's still a signed-capability surface. Fails OPEN by design.
  const ip = getRequestIp(req);
  const rl = await rateLimit(`r-pay-link:${ip}`, { requests: 20, window: '1m' });
  if (!rl.ok) return safeFallback();

  // The URL token IS a deposit grant (long-lived variant). Tampered/expired/
  // wrong-purpose → storefront, never an error page.
  const verified = verifyDepositGrantToken(token);
  if (!verified.ok) return safeFallback();
  const { consumerId, referralId } = verified.payload;

  // Pre-select the cut from the referral's Order Type so the page opens on the
  // exact thing the rancher quoted. Best-effort: a read failure still lands
  // the buyer on the deposit page (page re-loads the referral itself).
  let cutParam = '';
  try {
    const referral = await getRecordById(TABLES.REFERRALS, referralId);
    const orderType = String(referral?.['Order Type'] || '').trim().toLowerCase();
    if (orderType === 'quarter' || orderType === 'half' || orderType === 'whole') {
      cutParam = `?cut=${orderType}`;
    }
  } catch {
    /* page handles cut selection */
  }

  // STAMP THE OPEN (2026-07-19). This route is the ONLY place a buyer can click
  // through a pay link, and it was never recording that they did — so
  // 'Deposit Link Opened At' read NEVER on every referral, forever. That dead
  // gauge made a healthy funnel look broken: 7 stalled deposits were
  // indistinguishable from 7 buyers who never saw the email, and diagnosing a
  // live incident took a full night instead of five minutes.
  //
  // Fire-and-forget: a stamp failure must NEVER block a buyer reaching checkout.
  // Idempotent by intent — we record FIRST open only, so the field answers
  // "did this buyer ever engage?" without later clicks overwriting the signal.
  try {
    const existing = await getRecordById(TABLES.REFERRALS, referralId).catch(() => null);
    if (existing && !String(existing['Deposit Link Opened At'] || '').trim()) {
      await updateRecord(TABLES.REFERRALS, referralId, {
        'Deposit Link Opened At': new Date().toISOString(),
      }).catch(() => {});
    }
  } catch {
    /* never block the buyer */
  }

  const res = NextResponse.redirect(`${base}/checkout/${referralId}/deposit${cutParam}`, 302);
  try {
    // Fresh SHORT-ttl cookie grant — the long URL-token TTL never becomes the
    // session lifetime. Same scoping: this referral only, never /member.
    const cookieGrant = mintDepositGrantToken({ consumerId, referralId });
    setDepositGrantCookie(res, cookieGrant);
  } catch {
    // Cookie mint failure still lands on the page — a logged-in member cookie
    // may carry them; otherwise the page shows its sign-in state.
  }
  return res;
}
