// GET /api/shopify/oauth/callback — Shopify redirects here after the
// distributor approves the install. Performs ALL of the docs' security
// checks, exchanges the code for the offline token, then hands off to the
// SAME connectShopifyStore engine every other door uses (validate store,
// register webhooks, encrypt + save config, catalog dry-run).
//
// Security checks (shopify.dev authorization-code-grant, in order):
//   1. state verifies (our signed JWT) AND its nonce matches the httpOnly
//      cookie set at install time (CSRF, two factors).
//   2. shop param is a strict {shop}.myshopify.com hostname AND equals the
//      shop the pending config was staged for (a valid signature from the
//      WRONG store must not complete this rancher's install).
//   3. hmac param verifies against the app's client secret (sorted-params
//      hex digest — the OAuth variant, not the webhook variant).
// Any failure → branded failure page, nothing persisted, connector inert.

import { NextResponse } from 'next/server';
import { getRecordById, TABLES } from '@/lib/airtable';
import {
  verifyOauthState,
  verifyOauthCallbackHmac,
  parsePendingIntegration,
  isValidShopDomain,
  publicAppCreds,
  OAUTH_NONCE_COOKIE,
} from '@/lib/shopifyOauth';
import { parseIntegration } from '@/lib/fulfillmentConnector';
import { decryptSecret } from '@/lib/integrationCrypto';
import { rateLimit, getRequestIp } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

// The nonce cookie is scoped to path '/api/shopify/oauth' — a bare delete()
// defaults to path '/' and never clears it (review 2026-07-21). Expire it on
// the exact path it was set with.
function clearNonce(res: NextResponse): NextResponse {
  res.cookies.set(OAUTH_NONCE_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api/shopify/oauth',
    maxAge: 0,
  });
  return res;
}

// Failures at these stages mean a DISTRIBUTOR actually clicked and approved
// and then hit a wall — Ben must hear about it or they bounce silently and
// never say anything (review 2026-07-21). Pre-click failures (expired link,
// rate limit) stay quiet.
const ALERT_REASONS = new Set([
  'shop-mismatch',
  'bad-hmac',
  'missing-code',
  'secret-unavailable',
  'token-exchange',
  'store-validation',
]);

async function fail(reason: string, context?: string): Promise<NextResponse> {
  if (ALERT_REASONS.has(reason)) {
    try {
      const { sendOperatorSignal } = await import('@/lib/operatorSignal');
      await sendOperatorSignal({
        urgency: 'loud',
        kind: 'system-error',
        summary: `Store install FAILED mid-flow — ${reason}`,
        detail:
          `A distributor clicked their install link, approved on Shopify, and then hit "${reason}".` +
          (context ? `\n${context}` : '') +
          `\nThey saw the branded failure page. Reach out before they go cold.`,
        dedupeKey: `shopify-oauth-fail-${reason}`,
        dedupeWindowMs: 30 * 60 * 1000,
      });
    } catch {
      /* alert is best-effort */
    }
  }
  return clearNonce(
    NextResponse.redirect(`${SITE_URL}/store-connected?ok=0&why=${encodeURIComponent(reason)}`, 302),
  );
}

export async function GET(req: Request) {
  const rl = await rateLimit(`shopify-oauth-cb:${getRequestIp(req)}`, { requests: 10, window: '15m' });
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

  // 1. state + CSRF nonce cookie.
  const state = verifyOauthState(query.state);
  if (!state.ok) return fail('bad-state');
  const cookieHeader = req.headers.get('cookie') || '';
  const cookieNonce = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${OAUTH_NONCE_COOKIE}=`))
    ?.slice(OAUTH_NONCE_COOKIE.length + 1);
  if (!cookieNonce || cookieNonce !== state.payload.nonce) return fail('bad-nonce');

  // 2. shop shape + pin to the staged shop.
  const shop = String(query.shop || '').toLowerCase().trim();
  if (!isValidShopDomain(shop)) return fail('bad-shop');

  const rancher: any = await getRecordById(TABLES.RANCHERS, state.payload.rancherId).catch(() => null);
  if (!rancher) return fail('unknown-rancher');
  const raw = rancher['Fulfillment Integration'];

  // PUBLIC-APP install (Phase 2): one app, env credentials, no staged pending
  // config — the state JWT carries the card's choices and pins the shop.
  if (state.payload.pub) {
    const creds = publicAppCreds();
    if (!creds) return fail('secret-unavailable');
    if (state.payload.shop !== shop) return fail('shop-mismatch');
    if (!verifyOauthCallbackHmac(query, creds.clientSecret)) return fail('bad-hmac');
    const pubCode = String(query.code || '').trim();
    if (!pubCode) return fail('missing-code');
    let pubToken = '';
    try {
      const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, code: pubCode }),
      });
      const tokenBody: any = await tokenRes.json().catch(() => null);
      pubToken = String(tokenBody?.access_token || '');
      if (!tokenRes.ok || !pubToken) return fail('token-exchange', `Shop: ${shop} (http ${tokenRes.status})`);
    } catch (e: any) {
      console.error('[shopify-oauth] public token exchange error:', e?.message);
      return fail('token-exchange');
    }
    try {
      const { connectShopifyStore } = await import('@/lib/shopifyConnectFlow');
      const result = await connectShopifyStore({
        rancherId: state.payload.rancherId,
        shop,
        token: pubToken,
        apiSecret: creds.clientSecret, // public-app webhooks are signed with the app secret
        mode: state.payload.mode || 'sync',
        markupPercent: state.payload.markupPercent ?? null,
      });
      if (!result.ok) return fail('store-validation', `Shop: ${shop} — ${result.report.join('; ').slice(0, 300)}`);
      try {
        const { sendOperatorSignal } = await import('@/lib/operatorSignal');
        await sendOperatorSignal({
          urgency: 'normal',
          kind: 'system-error',
          summary: `🔌 Store INSTALLED (public app) — ${String(rancher['Ranch Name'] || rancher['Operator Name'] || shop)}`,
          detail: `${shop} connected one-click (${state.payload.mode || 'sync'} mode).\n${result.report.join('\n')}`,
          dedupeKey: `shopify-oauth-installed-${state.payload.rancherId}`,
          dedupeWindowMs: 5 * 60 * 1000,
        });
      } catch { /* best-effort */ }
    } catch (e: any) {
      console.error('[shopify-oauth] public connect flow error:', e?.message);
      return fail('store-validation');
    }
    return clearNonce(NextResponse.redirect(`${SITE_URL}/store-connected?ok=1`, 302));
  }

  const pending = parsePendingIntegration(raw);
  if (!pending) {
    if (parseIntegration(raw)) {
      // Callback replay after a completed install (refresh/back button) —
      // success page, no re-exchange (the code is single-use anyway).
      return clearNonce(NextResponse.redirect(`${SITE_URL}/store-connected?ok=1&already=1`, 302));
    }
    return fail('not-staged');
  }
  if (shop !== pending.shop) return fail('shop-mismatch');

  // 3. hmac with the app's client secret.
  let clientSecret = '';
  try {
    clientSecret = decryptSecret(pending.encClientSecret);
  } catch {
    return fail('secret-unavailable');
  }
  if (!verifyOauthCallbackHmac(query, clientSecret)) return fail('bad-hmac');

  const code = String(query.code || '').trim();
  if (!code) return fail('missing-code');

  // Exchange the code for the offline access token (non-expiring — we do
  // NOT pass expiring=1; the connector needs a durable credential).
  let accessToken = '';
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: pending.clientId,
        client_secret: clientSecret,
        code,
      }),
    });
    const tokenBody: any = await tokenRes.json().catch(() => null);
    accessToken = String(tokenBody?.access_token || '');
    if (!tokenRes.ok || !accessToken) {
      console.error(`[shopify-oauth] token exchange failed for ${shop}: http ${tokenRes.status}`);
      return fail('token-exchange', `Shop: ${shop} (http ${tokenRes.status})`);
    }
  } catch (e: any) {
    console.error('[shopify-oauth] token exchange error:', e?.message);
    return fail('token-exchange');
  }

  // Hand off to the shared connect engine: validates the store with the new
  // token, registers fulfillment webhooks, encrypts + SAVES the completed
  // config (replacing the pending one), runs the sync dry-run. Webhook HMAC
  // secret for OAuth apps = the app's client secret.
  try {
    const { connectShopifyStore } = await import('@/lib/shopifyConnectFlow');
    const result = await connectShopifyStore({
      rancherId: state.payload.rancherId,
      shop,
      token: accessToken,
      apiSecret: clientSecret,
      mode: pending.mode,
      markupPercent: pending.markupPercent,
      category: pending.category,
    });
    if (!result.ok) {
      console.error('[shopify-oauth] connect flow failed:', result.report.join('; '));
      return fail('store-validation', `Shop: ${shop} — ${result.report.join('; ').slice(0, 300)}`);
    }
    // Tell Ben — a distributor just self-installed.
    try {
      const { sendOperatorSignal } = await import('@/lib/operatorSignal');
      await sendOperatorSignal({
        urgency: 'normal',
        kind: 'system-error',
        summary: `🔌 Store INSTALLED — ${String(rancher['Ranch Name'] || rancher['Operator Name'] || shop)}`,
        detail: `${shop} connected via one-click install (${pending.mode} mode).\n${result.report.join('\n')}`,
        dedupeKey: `shopify-oauth-installed-${state.payload.rancherId}`,
        dedupeWindowMs: 5 * 60 * 1000,
      });
    } catch {
      /* notify is best-effort */
    }
  } catch (e: any) {
    console.error('[shopify-oauth] connect flow error:', e?.message);
    return fail('store-validation');
  }

  return clearNonce(NextResponse.redirect(`${SITE_URL}/store-connected?ok=1`, 302));
}
