// GET /api/shopify/app-store — the public App Store entry point.
//
// This is the app's `application_url`: Shopify loads it (a) when its App
// Store review robot installs the app on a test store and (b) whenever a
// merchant opens the app from their admin. Both arrive as a top-level GET
// with `?shop={shop}.myshopify.com&hmac=...&timestamp=...`.
//
// The App Store automated check requires this URL to IMMEDIATELY start
// OAuth: 302 straight to https://{shop}/admin/oauth/authorize with our
// public-app client id. No landing page, no interstitial.
//
// Anonymous installs (no rancher session) get a claim-flow state: the OAuth
// callback recognizes the sentinel rancher id, performs every security
// check, persists NOTHING, and lands the merchant on /store-connected with
// the dashboard CTA — they sign up / log in and connect from the dashboard
// card (instant re-consent, since the app is already installed).
//
// Signed-in ranchers opening the app from Shopify admin skip OAuth and go
// straight to their dashboard.

import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import {
  isValidShopDomain,
  mintOauthState,
  buildAuthorizeUrl,
  verifyOauthCallbackHmac,
  publicAppCreds,
  APPSTORE_STATE_RANCHER,
  OAUTH_NONCE_COOKIE,
} from '@/lib/shopifyOauth';
import { rateLimit, getTrustedClientIp } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
const RANCHER_AUTH_COOKIE = 'bhc-rancher-auth';

function fail(reason: string): NextResponse {
  return NextResponse.redirect(`${SITE_URL}/store-connected?ok=0&why=${encodeURIComponent(reason)}`, 302);
}

export async function GET(req: Request) {
  const rl = await rateLimit(`shopify-appstore-entry:${getTrustedClientIp(req)}`, {
    requests: 20,
    window: '15m',
  });
  if (!rl.ok) return fail('too-many-attempts');

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return fail('bad-request');
  }
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    query[k] = v;
  });

  // Bare visit with no shop context (someone typed the URL) — homepage.
  const shop = String(query.shop || '').toLowerCase().trim();
  if (!shop) return NextResponse.redirect(SITE_URL, 302);
  if (!isValidShopDomain(shop)) return fail('bad-shop');

  const creds = publicAppCreds();
  if (!creds) return fail('secret-unavailable');

  // Shopify signs application_url loads with the same sorted-params digest
  // as the OAuth callback. A present-but-wrong hmac is a spoof — reject it.
  // (An absent hmac is a plain deep link; starting OAuth is harmless.)
  if (query.hmac && !verifyOauthCallbackHmac(query, creds.clientSecret)) {
    return fail('bad-hmac');
  }

  // Already signed in as a rancher (merchant re-opening the app from their
  // Shopify admin) — their dashboard IS the app UI.
  const cookieHeader = req.headers.get('cookie') || '';
  const hasSession = cookieHeader
    .split(';')
    .some((c) => c.trim().startsWith(`${RANCHER_AUTH_COOKIE}=`));
  if (hasSession) {
    return NextResponse.redirect(`${SITE_URL}/rancher?tab=products`, 302);
  }

  // Anonymous App Store install — start OAuth immediately with the claim
  // sentinel. The callback verifies everything and persists nothing.
  const nonce = randomBytes(16).toString('hex');
  const state = mintOauthState({
    rancherId: APPSTORE_STATE_RANCHER,
    nonce,
    pub: true,
    shop,
    mode: 'sync',
  });
  const authorizeUrl = buildAuthorizeUrl({
    shop,
    clientId: creds.clientId,
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
