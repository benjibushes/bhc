// lib/orderStatusLink.ts
//
// BUYER ORDER-STATUS LINK (shop-chain audit 2026-08-01).
//
// The product rail had NO buyer-facing order surface: the only non-admin,
// non-rancher, non-cron reader of Rancher Orders was the reviews query. A
// buyer's entire state model was their inbox — if the receipt got filed or
// the shipped mail never sent, "where is my beef?" had literally nowhere to
// go but a support reply.
//
// This mints the credential for /order/<token>: a SIGNED, order-scoped,
// READ-ONLY link that rides the receipt + shipped emails. Same durable-link
// idiom as lib/campaignReserve (/r/d, /r/b) and the /r/p, /r/f deposit links
// — never a raw record id in a URL (repo rule: guessable ids are not a
// credential, and `rec…` ids are enumerable-ish and leak across surfaces).
//
// SECURITY MODEL
//  - purpose:'order-status' — a distinct purpose value, so a member-session,
//    deposit-grant, campaign-reserve or broker-reserve token can never be
//    replayed here and this token can never be replayed there (the same
//    confused-deputy fence campaignReserve documents).
//  - Claims name ONE orderId. The page it unlocks is strictly read-only:
//    there is no action, no money movement, no session minted. The worst a
//    forwarded link can do is show that one order's card — which is exactly
//    what forwarding the receipt email already does.
//  - Long TTL on purpose (ORDER_STATUS_TTL): a buyer checks "did it ship?"
//    weeks later, and an expired link on a read-only page is pure support
//    load. Nothing money-bearing rides it.
//
// Hermetic: depends only on lib/jwt (which reads process.env.JWT_SECRET
// directly), so this module is unit-testable without prod env.

import { signJwt, verifyJwtWithFallback } from '@/lib/jwt';

export const ORDER_STATUS_PURPOSE = 'order-status' as const;

/** ~6 months. Read-only + order-scoped, so a long life costs nothing. */
export const ORDER_STATUS_TTL = '180d';

export interface OrderStatusClaims {
  orderId: string;
}

export interface OrderStatusPayload extends OrderStatusClaims {
  purpose: typeof ORDER_STATUS_PURPOSE;
  iat?: number;
  exp?: number;
}

export type OrderStatusVerify =
  | { ok: true; payload: OrderStatusPayload }
  | { ok: false; reason: 'missing' | 'invalid' | 'wrong-purpose' };

const RECORD_ID = /^rec[A-Za-z0-9]{14}$/;

/**
 * Mint the buyer's order-status token. Throws on a malformed order id so a
 * broken email can never ship a link that resolves to nothing (callers wrap
 * in try/catch and simply omit the link — see settleProductPurchase).
 */
export function mintOrderStatusToken(claims: OrderStatusClaims): string {
  const orderId = String(claims?.orderId || '').trim();
  if (!RECORD_ID.test(orderId)) {
    throw new Error('mintOrderStatusToken: orderId must be an Airtable record id');
  }
  return signJwt({ purpose: ORDER_STATUS_PURPOSE, orderId }, { expiresIn: ORDER_STATUS_TTL });
}

/**
 * Verify a token from the /order/<token> path. Discriminated result, never
 * throws — the page must render an honest "this link isn't valid any more"
 * card on every failure mode (missing, expired, tampered, wrong purpose),
 * never a 500 and never a leak of whether that order exists.
 */
export function verifyOrderStatusToken(token: string | null | undefined): OrderStatusVerify {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  // Bound length pre-verify — jwt.verify on a multi-KB payload still burns CPU
  // (mirrors verifyCampaignReserveToken).
  if (token.length > 4096) return { ok: false, reason: 'invalid' };
  let decoded: any;
  try {
    decoded = verifyJwtWithFallback<any>(token);
  } catch {
    return { ok: false, reason: 'invalid' }; // expired OR tampered OR bad secret
  }
  if (!decoded || decoded.purpose !== ORDER_STATUS_PURPOSE) {
    return { ok: false, reason: 'wrong-purpose' };
  }
  const orderId = String(decoded.orderId || '').trim();
  if (!RECORD_ID.test(orderId)) return { ok: false, reason: 'invalid' };
  return { ok: true, payload: { purpose: ORDER_STATUS_PURPOSE, orderId } };
}

/** Relative path for a minted token. */
export function orderStatusPath(token: string): string {
  return `/order/${encodeURIComponent(String(token || ''))}`;
}

/**
 * Absolute URL for an email. Returns '' when the token can't be minted (no
 * JWT secret, bad id) so callers can `link ? render : omit` without a branch
 * per template — a missing link is fine; a broken one is not.
 */
export function orderStatusUrlFor(orderId: string, siteUrl?: string): string {
  try {
    const base = String(
      siteUrl || process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com',
    ).replace(/\/+$/, '');
    return `${base}${orderStatusPath(mintOrderStatusToken({ orderId }))}`;
  } catch {
    return '';
  }
}
