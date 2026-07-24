// Provider-agnostic fulfillment connector contract + per-rancher config
// parsing. JSON-in-multiline-text on Ranchers.'Fulfillment Integration' —
// same defensive-parse pattern as Push Subscriptions (lib/rancherPush.ts).
// Providers register here; settlement/crons/webhooks speak only this
// interface, never a provider SDK.
//
// Business model context (locked 2026-07-21): BHC brings the buyer and takes
// its margin upfront on the existing Stripe Connect direct charge. The
// connector's ONLY job is logistics — inject the already-paid order into the
// distributor's own system so their existing fulfillment stack ships it.

export interface IntegrationConfig {
  v: 1;
  provider: 'shopify';
  shop: string;              // *.myshopify.com host, no scheme
  encToken: string;          // AES-GCM (lib/integrationCrypto)
  encApiSecret: string;      // custom app API secret (webhook HMAC)
  mode: 'sync' | 'manual';
  markupPercent?: number | null;
  locationId?: string | null;
  /**
   * Optional Rancher Products Category stamped on every synced row (e.g.
   * 'Merch' keeps the BHC merch line in its own /shop section, never mixed
   * into the beef groups). Unset → rows land in the 'more' group.
   */
  category?: string | null;
}

export interface PushLineItem { sku: string; quantity: number; title: string }
export interface PushOrderInput {
  orderRef: string;          // BHC Rancher Orders 'Order Ref' — human-readable, becomes external note (NOT unique)
  // Globally-unique per-order dedup identity (the Rancher Orders record id).
  // 'Order Ref' is NOT unique — a repeat buyer of the same product produces an
  // identical ref — so the pre-create dedup + idempotency key MUST key on this,
  // never on orderRef, or the 2nd order would be short-circuited and never ship.
  dedupToken: string;
  buyerName: string;
  buyerEmail: string;
  shipToAddress: string;     // free-text from checkout; provider does best-effort split
  lineItems: PushLineItem[];
}
export type PushResult =
  | { ok: true; externalOrderId: string }
  | { ok: false; permanent: boolean; error: string };

export interface FulfillmentConnector {
  provider: IntegrationConfig['provider'];
  validateConfig(cfg: IntegrationConfig): Promise<{ ok: boolean; detail: string }>;
  pushOrder(cfg: IntegrationConfig, order: PushOrderInput): Promise<PushResult>;
  cancelOrder(cfg: IntegrationConfig, externalOrderId: string, staffNote: string): Promise<{ ok: boolean; error?: string }>;
}

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function parseIntegration(raw: unknown): IntegrationConfig | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || obj.v !== 1 || obj.provider !== 'shopify') return null;
  const shop = String(obj.shop || '').toLowerCase().trim();
  if (!SHOP_RE.test(shop)) return null;
  if (!obj.encToken || !obj.encApiSecret) return null;
  if (obj.mode !== 'sync' && obj.mode !== 'manual') return null;
  return {
    v: 1, provider: 'shopify', shop,
    encToken: String(obj.encToken), encApiSecret: String(obj.encApiSecret),
    mode: obj.mode,
    markupPercent: typeof obj.markupPercent === 'number' ? obj.markupPercent : null,
    locationId: obj.locationId ? String(obj.locationId) : null,
    category: obj.category ? String(obj.category).slice(0, 40) : null,
  };
}

import { shopifyConnector } from './shopifyConnector';

export function getConnector(provider: IntegrationConfig['provider']): FulfillmentConnector {
  if (provider === 'shopify') return shopifyConnector;
  throw new Error(`Unknown fulfillment provider: ${provider}`);
}
