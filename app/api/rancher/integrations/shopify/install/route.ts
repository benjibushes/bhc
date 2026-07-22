// POST /api/rancher/integrations/shopify/install — start a PUBLIC-APP
// one-click install for the signed-in rancher (Phase 2, zero-friction).
// Body: { shop, mode, markupPercent? }. Returns { authorizeUrl } — the card
// redirects the browser there; Shopify's consent screen is the only thing
// the rancher ever sees. No tokens, no custom apps, no Partner Dashboard.
//
// The state JWT pins the rancher + their card choices (no pending config is
// staged for public installs); the CSRF nonce cookie mirrors the custom-app
// install route.

import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { requireRancher } from '@/lib/rancherAuth';
import {
  publicAppCreds,
  isValidShopDomain,
  mintOauthState,
  buildAuthorizeUrl,
  OAUTH_NONCE_COOKIE,
} from '@/lib/shopifyOauth';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export async function POST(request: Request) {
  const r = await requireRancher(request);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  const rl = await rateLimit(`shopify-pub-install:${getRequestIp(request)}`, { requests: 5, window: '15m' });
  if (!rl.ok) return NextResponse.json({ error: 'Too many attempts — wait a few minutes.' }, { status: 429 });

  const creds = publicAppCreds();
  if (!creds) {
    // Don't reference "the token form below" — the card only calls this from
    // the one-click layout, where that form isn't rendered (the card swaps
    // layouts itself on a 503).
    return NextResponse.json(
      { error: 'One-click connect is not available right now — connect with the token steps instead, or text Ben.' },
      { status: 503 },
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const shop = String(body?.shop || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const mode = body?.mode === 'manual' ? 'manual' : 'sync';
  const category = body?.category ? String(body.category).slice(0, 40) : null;
  const markupPercent =
    body?.markupPercent !== undefined && body?.markupPercent !== null && body?.markupPercent !== ''
      && Number.isFinite(Number(body.markupPercent))
      ? Math.min(300, Math.max(0, Number(body.markupPercent)))
      : null;
  if (!isValidShopDomain(shop)) {
    return NextResponse.json(
      { error: 'Enter your *.myshopify.com address (Shopify admin → Settings → Domains).' },
      { status: 400 },
    );
  }

  const nonce = randomBytes(16).toString('hex');
  const state = mintOauthState({ rancherId: session.rancherId, nonce, pub: true, mode, markupPercent, shop, category });
  const authorizeUrl = buildAuthorizeUrl({
    shop,
    clientId: creds.clientId,
    redirectUri: `${SITE_URL}/api/shopify/oauth/callback`,
    state,
  });

  const res = NextResponse.json({ authorizeUrl });
  res.cookies.set(OAUTH_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api/shopify/oauth',
    maxAge: 60 * 60,
  });
  return res;
}
