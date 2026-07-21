// GET /api/shopify/oauth/install?l=<installLinkToken>
//
// The link Ben texts a distributor (minted by /storelink). Verifies the
// link, loads the rancher's PENDING integration config (shop + app client
// creds, staged by /storelink), mints a fresh per-attempt OAuth state +
// CSRF nonce cookie, and 302s to Shopify's consent screen. The distributor
// sees only: "BuyHalfCow wants to manage orders and read products — Install".
//
// Every failure lands on the branded /store-connected page with a plain
// explanation — this URL is clicked from an email/text by a non-technical
// store owner; never show them JSON.

import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { getRecordById, TABLES } from '@/lib/airtable';
import {
  verifyInstallLinkToken,
  parsePendingIntegration,
  mintOauthState,
  buildAuthorizeUrl,
  OAUTH_NONCE_COOKIE,
} from '@/lib/shopifyOauth';
import { parseIntegration } from '@/lib/fulfillmentConnector';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

function fail(base: string, reason: string): NextResponse {
  return NextResponse.redirect(`${base}/store-connected?ok=0&why=${encodeURIComponent(reason)}`, 302);
}

export async function GET(req: Request) {
  const base = SITE_URL;

  const rl = await rateLimit(`shopify-oauth-install:${getRequestIp(req)}`, { requests: 10, window: '15m' });
  if (!rl.ok) return fail(base, 'too-many-attempts');

  let linkToken = '';
  try {
    linkToken = new URL(req.url).searchParams.get('l') || '';
  } catch {
    return fail(base, 'bad-link');
  }
  const link = verifyInstallLinkToken(linkToken);
  if (!link.ok) return fail(base, 'expired-link');

  const rancher: any = await getRecordById(TABLES.RANCHERS, link.payload.rancherId).catch(() => null);
  if (!rancher) return fail(base, 'unknown-rancher');

  const raw = rancher['Fulfillment Integration'];
  const pending = parsePendingIntegration(raw);
  if (!pending) {
    // Already completed? Re-clicking a stale install link after a successful
    // install is common — land them on success, not an error.
    if (parseIntegration(raw)) {
      return NextResponse.redirect(`${base}/store-connected?ok=1&already=1`, 302);
    }
    return fail(base, 'not-staged');
  }

  const nonce = randomBytes(16).toString('hex');
  const state = mintOauthState({ rancherId: link.payload.rancherId, nonce });
  const authorizeUrl = buildAuthorizeUrl({
    shop: pending.shop,
    clientId: pending.clientId,
    redirectUri: `${SITE_URL}/api/shopify/oauth/callback`,
    state,
  });

  const res = NextResponse.redirect(authorizeUrl, 302);
  res.cookies.set(OAUTH_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax', // must survive the cross-site top-level redirect back
    path: '/api/shopify/oauth',
    maxAge: 60 * 60,
  });
  return res;
}
