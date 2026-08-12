// Shopify OAuth (authorization code grant, non-embedded) — the one-click
// install rail (connector plan §8 Phase 1). A distributor clicks an install
// link, approves scopes on Shopify's consent screen, and the callback
// exchanges the code for an offline token and auto-configures the
// fulfillment connector. No merchant-side API steps.
//
// Security model follows shopify.dev "Implement authorization code grant
// manually" exactly:
//   1. state = OUR signed JWT (rancher-pinned + nonce) AND the nonce is
//      echoed in an httpOnly cookie set at install time (CSRF, two factors).
//   2. Callback hmac param = HMAC-SHA256 hex over the alphabetically-sorted
//      remaining query params, keyed by the app's client secret.
//      NOTE: deliberately different from webhook HMAC (base64 over raw body).
//   3. shop param strictly matches {shop}.myshopify.com and must equal the
//      shop the pending config was created for.
//
// Pure/hermetic: no Airtable, no fetch — routes own I/O. Unit-tested.

import { createHmac, timingSafeEqual } from 'crypto';
import { signJwt, verifyJwtWithFallback } from '@/lib/jwt';
import type { VerifyResult } from '@/lib/campaignReserve';

// read_product_listings: required by the channel-connection APIs
// (channelCreate — shopify.dev channel-connections "Requirements"), added for
// App Store review 128658 (sales-channel conversion). NOTE the app's
// CLI-managed config (shopify.app.toml, deployed via `shopify app deploy`)
// must declare the same scope — for declarative-scope apps Shopify honors the
// TOML, not this URL param. read_only_own_orders is deliberately NOT here:
// Shopify's review team adds that flag to the sales channel during review
// (checklist 5.7.1).
export const SHOPIFY_OAUTH_SCOPES = 'write_orders,read_orders,read_products,read_product_listings';

export const OAUTH_STATE_PURPOSE = 'shopify-oauth-state' as const;
export const INSTALL_LINK_PURPOSE = 'shopify-install-link' as const;
export const OAUTH_NONCE_COOKIE = 'bhc-shopify-oauth-nonce';

// Sentinel rancherId for anonymous App Store installs (no rancher account
// yet). The OAuth callback runs every security check for this state, saves
// NOTHING, and lands the merchant on the claim page to sign up / log in.
export const APPSTORE_STATE_RANCHER = '__appstore__';

// Shop hostname per the docs' recommended pattern — anchored BOTH ends (the
// docs' example regex is unanchored at the end; an attacker's
// x.myshopify.com.evil.com must not pass).
const SHOP_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export function isValidShopDomain(shop: unknown): shop is string {
  return typeof shop === 'string' && shop.length <= 100 && SHOP_RE.test(shop);
}

// ---------------------------------------------------------------------------
// Install-link token: long-lived (the link sits in a distributor's inbox),
// pins the rancher row only — everything else is re-read server-side at
// click time, so a leaked link can only ever start OUR flow for THAT rancher.
// ---------------------------------------------------------------------------

export interface InstallLinkClaims { rancherId: string }
export interface InstallLinkPayload extends InstallLinkClaims {
  purpose: typeof INSTALL_LINK_PURPOSE;
  iat?: number;
  exp?: number;
}

export function mintInstallLinkToken(claims: InstallLinkClaims): string {
  const rancherId = String(claims.rancherId || '').trim();
  if (!rancherId) throw new Error('mintInstallLinkToken: rancherId required');
  return signJwt({ purpose: INSTALL_LINK_PURPOSE, rancherId }, { expiresIn: '30d' });
}

export function verifyInstallLinkToken(token: string | null | undefined): VerifyResult<InstallLinkPayload> {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  if (token.length > 4096) return { ok: false, reason: 'invalid' };
  let decoded: any;
  try {
    decoded = verifyJwtWithFallback<any>(token);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!decoded || decoded.purpose !== INSTALL_LINK_PURPOSE) return { ok: false, reason: 'wrong-purpose' };
  const rancherId = String(decoded.rancherId || '').trim();
  if (!rancherId) return { ok: false, reason: 'invalid' };
  return { ok: true, payload: { purpose: INSTALL_LINK_PURPOSE, rancherId } };
}

// ---------------------------------------------------------------------------
// OAuth state: short-lived, per-attempt, carries the CSRF nonce that must
// ALSO come back via the httpOnly cookie.
// ---------------------------------------------------------------------------

export interface OauthStateClaims {
  rancherId: string;
  nonce: string;
  /** Public-app install (env creds, shop from callback) vs staged custom app. */
  pub?: boolean;
  /** Public installs carry the card's choices — no pending config exists. */
  mode?: 'sync' | 'manual';
  markupPercent?: number | null;
  shop?: string;
  category?: string | null;
}
export interface OauthStatePayload extends OauthStateClaims {
  purpose: typeof OAUTH_STATE_PURPOSE;
  iat?: number;
  exp?: number;
}

export function mintOauthState(claims: OauthStateClaims): string {
  const rancherId = String(claims.rancherId || '').trim();
  const nonce = String(claims.nonce || '').trim();
  if (!rancherId) throw new Error('mintOauthState: rancherId required');
  if (!nonce) throw new Error('mintOauthState: nonce required');
  return signJwt(
    {
      purpose: OAUTH_STATE_PURPOSE, rancherId, nonce,
      ...(claims.pub ? { pub: true } : {}),
      ...(claims.mode ? { mode: claims.mode } : {}),
      ...(claims.markupPercent != null ? { markupPercent: claims.markupPercent } : {}),
      ...(claims.shop ? { shop: claims.shop } : {}),
      ...(claims.category ? { category: claims.category } : {}),
    },
    { expiresIn: '1h' },
  );
}

export function verifyOauthState(token: string | null | undefined): VerifyResult<OauthStatePayload> {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  if (token.length > 4096) return { ok: false, reason: 'invalid' };
  let decoded: any;
  try {
    decoded = verifyJwtWithFallback<any>(token);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!decoded || decoded.purpose !== OAUTH_STATE_PURPOSE) return { ok: false, reason: 'wrong-purpose' };
  const rancherId = String(decoded.rancherId || '').trim();
  const nonce = String(decoded.nonce || '').trim();
  if (!rancherId || !nonce) return { ok: false, reason: 'invalid' };
  return {
    ok: true,
    payload: {
      purpose: OAUTH_STATE_PURPOSE, rancherId, nonce,
      pub: decoded.pub === true,
      mode: decoded.mode === 'sync' || decoded.mode === 'manual' ? decoded.mode : undefined,
      markupPercent: typeof decoded.markupPercent === 'number' ? decoded.markupPercent : null,
      shop: decoded.shop ? String(decoded.shop) : undefined,
      category: decoded.category ? String(decoded.category).slice(0, 40) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Callback HMAC (docs "Security checks"): remove `hmac`, sort the remaining
// params alphabetically as `key=value` joined by `&`, HMAC-SHA256 with the
// client secret, hex, timing-safe compare.
// ---------------------------------------------------------------------------

export function verifyOauthCallbackHmac(
  query: Record<string, string>,
  clientSecret: string,
): boolean {
  const given = String(query?.hmac || '');
  if (!given || !clientSecret) return false;
  const message = Object.keys(query)
    .filter((k) => k !== 'hmac')
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&');
  const digest = createHmac('sha256', clientSecret).update(message, 'utf8').digest('hex');
  try {
    const a = Buffer.from(digest, 'utf8');
    const b = Buffer.from(given, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function buildAuthorizeUrl(input: {
  shop: string;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const qs = new URLSearchParams({
    client_id: input.clientId,
    scope: SHOPIFY_OAUTH_SCOPES,
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `https://${input.shop}/admin/oauth/authorize?${qs.toString()}`;
}

// ---------------------------------------------------------------------------
// Pending integration config — stored in the SAME Ranchers field as the
// completed config ('Fulfillment Integration'), created by /storelink,
// completed by the OAuth callback. parseIntegration (lib/fulfillmentConnector)
// rejects it (no encToken) so the connector stays inert until install
// completes; only this parser accepts it.
// ---------------------------------------------------------------------------

export interface PendingIntegration {
  v: 1;
  provider: 'shopify';
  pending: true;
  shop: string;
  clientId: string;
  encClientSecret: string;
  mode: 'sync' | 'manual';
  markupPercent: number | null;
  category: string | null;
}

export function parsePendingIntegration(raw: unknown): PendingIntegration | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || obj.v !== 1 || obj.provider !== 'shopify' || obj.pending !== true) return null;
  const shop = String(obj.shop || '').toLowerCase().trim();
  if (!isValidShopDomain(shop)) return null;
  const clientId = String(obj.clientId || '').trim();
  if (!clientId || !obj.encClientSecret) return null;
  if (obj.mode !== 'sync' && obj.mode !== 'manual') return null;
  return {
    v: 1,
    provider: 'shopify',
    pending: true,
    shop,
    clientId,
    encClientSecret: String(obj.encClientSecret),
    mode: obj.mode,
    markupPercent: typeof obj.markupPercent === 'number' ? obj.markupPercent : null,
    category: obj.category ? String(obj.category).slice(0, 40) : null,
  };
}

/** Public-app credentials (ONE app for every rancher) — set once in Vercel. */
export function publicAppCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = String(process.env.SHOPIFY_APP_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.SHOPIFY_APP_CLIENT_SECRET || '').trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** True only when the one-click public-app flow may be OFFERED to ranchers:
 *  creds set AND SHOPIFY_PUBLIC_APP_LIVE=1|true (flip on Shopify's approval
 *  email). Creds alone are NOT enough (audit 2026-07-21): they are set DURING
 *  review so the compliance-webhook HMAC + OAuth callback keep working, but
 *  Shopify refuses merchant installs of an in-review public app — offering
 *  the flow then dead-ends every rancher on a Shopify-owned error page with
 *  no callback and no operator alert. Gate the OFFER surfaces (status
 *  publicApp field, install route) on this; never the webhook/callback. */
export function publicAppLive(): boolean {
  const flag = String(process.env.SHOPIFY_PUBLIC_APP_LIVE || '').trim().toLowerCase();
  return (flag === '1' || flag === 'true') && publicAppCreds() !== null;
}
