// Pure helpers for the Shopify orders/create webhook (B3 — real-time inventory).
//
// Problem: a sale on the rancher's OWN Shopify store only reaches BHC's
// 'Orders Left' via the 6h catalog cron / a products/update webhook, so /shop
// can oversell for up to 6h. Subscribing orders/create decrements immediately.
//
// The two correctness landmines (get these wrong and the feature is worse than
// nothing) both live here as pure, tested functions:
//   1. isBhcOriginOrder — BHC's OWN pushed orders ALSO fire orders/create, and
//      they already decremented 'Orders Left' at settlement. Decrementing again
//      would DOUBLE-count. BHC pushes carry sourceName 'BuyHalfCow' + tag 'BHC'
//      (see lib/shopifyConnector.pushOrder); either marker → skip.
//   2. orderDecrementPatch — mirrors the settlement decrement: blank/unlimited
//      stock is left untouched; a real count floors at 0; hitting 0 forces
//      Active off (Active requires qty>0 — sync computes approved && ACTIVE &&
//      qty>0). It NEVER flips Active on (that would bypass the curation gate).

export const BHC_ORDER_TAG = 'BHC';
export const BHC_SOURCE_NAME = 'BuyHalfCow';

/**
 * True when this webhook order is one BHC itself pushed into the store. Checks
 * BOTH markers because Shopify may normalize `source_name` (e.g. lowercase, or
 * substitute the app handle): tags survive, and vice-versa. `tags` arrives as a
 * comma-separated string in the webhook payload; also tolerate an array.
 */
export function isBhcOriginOrder(payload: any): boolean {
  const source = String(payload?.source_name || '').trim().toLowerCase();
  if (source === BHC_SOURCE_NAME.toLowerCase()) return true;
  const rawTags = payload?.tags;
  const tags: string[] = Array.isArray(rawTags)
    ? rawTags.map((t) => String(t))
    : String(rawTags || '').split(',');
  return tags.some((t) => t.trim().toLowerCase() === BHC_ORDER_TAG.toLowerCase());
}

/** Stable dedupe id for an orders/create event: the Shopify order id is created
 * once and is identical across redeliveries of the same order. Namespaced by
 * shop so ids can't collide across stores in the shared Stripe Events table. */
export function shopifyOrderEventId(shop: string, payload: any): string {
  const orderId = String(payload?.id ?? '').trim();
  return `shopify-order:${String(shop || '').toLowerCase().trim()}:${orderId}`;
}

export interface IngestLineItem { sku: string; quantity: number }

/** Extract decrementable line items: only those with a SKU (the join key to a
 * Rancher Products row) and a positive integer-ish quantity. */
export function extractOrderLineItems(payload: any): IngestLineItem[] {
  const items = Array.isArray(payload?.line_items) ? payload.line_items : [];
  const out: IngestLineItem[] = [];
  for (const li of items) {
    const sku = String(li?.sku || '').trim();
    if (!sku) continue;
    const quantity = Math.floor(Number(li?.quantity ?? 0));
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    out.push({ sku, quantity });
  }
  return out;
}

export type DecrementPatch = { 'Orders Left': number; Active?: false };

/**
 * The Airtable patch for decrementing one product row by `qty`, or null for a
 * no-op. Blank/null/'' 'Orders Left' = unlimited stock → left untouched (same
 * rule as productSettlement + marketplaceProducts). Floors at 0; at 0, forces
 * Active=false. Never sets Active=true (curation gate: only Ben's
 * 'Marketplace Approved' + a sync run may turn a listing back on).
 */
export function orderDecrementPatch(currentLeft: unknown, qty: number): DecrementPatch | null {
  if (currentLeft === undefined || currentLeft === null || currentLeft === '') return null; // unlimited
  const left = Number(currentLeft);
  if (!Number.isFinite(left)) return null;
  const q = Math.max(0, Math.floor(Number(qty) || 0));
  if (q <= 0) return null;
  const next = Math.max(0, left - q);
  const patch: DecrementPatch = { 'Orders Left': next };
  if (next === 0) patch.Active = false;
  return patch;
}
