// FulfillmentConnector provider #1. All calls = GraphQL Admin API 2026-01
// with the rancher's custom-app offline token (decrypted per call, never
// cached, never logged). Push = orderCreate financialStatus PAID with
// inventory decrement + Shopify-owned fulfillment email (Ben decision
// 2026-07-21: sendFulfillmentReceipt true / sendReceipt false — BHC already
// sent product_receipt). Cancel = orderCancel restock:true notify:false
// (BHC refunded via Stripe; no refundMethod — no Shopify payment exists).

import type { FulfillmentConnector, IntegrationConfig, PushResult } from './fulfillmentConnector';
import { decryptSecret } from './integrationCrypto';
import { createHash } from 'crypto';

const API_VERSION = '2026-01';

async function gql(cfg: IntegrationConfig, query: string, variables: any, extraHeaders?: Record<string, string>): Promise<{ status: number; body: any }> {
  const res = await fetch(`https://${cfg.shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': decryptSecret(cfg.encToken),
      ...(extraHeaders || {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* transient */ }
  return { status: res.status, body };
}

// H1(a): a STABLE per-order idempotency key. orderCreate is not naturally
// idempotent — a lost 504 response makes the net cron re-push and ships a
// SECOND live order. A deterministic key derived from the BHC 'Order Ref'
// (identical on every retry of the same row) lets Shopify dedupe a repeated
// create. orderRef is the only stable identity the connector receives
// (PushOrderInput carries no row id / PI), and it's deterministic per row.
export function orderIdempotencyKey(orderRef: string): string {
  return 'bhc-' + createHash('sha256').update(String(orderRef || '')).digest('hex').slice(0, 40);
}

// H1(b): pre-create dedup decision (pure). Given the store's recent BHC-tagged
// orders, return the id of the one that already carries THIS orderRef in its
// note (connector writes `BuyHalfCow order <orderRef> …` at push time), else
// null. A blank orderRef never matches — we must never false-short-circuit a
// real order onto an unrelated one.
export function matchExistingBhcOrder(
  nodes: Array<{ id?: unknown; note?: unknown; tags?: unknown }>,
  orderRef: string,
): string | null {
  const ref = String(orderRef || '').trim();
  if (!ref) return null;
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const note = String(n?.note || '');
    const tags = Array.isArray(n?.tags) ? n.tags.map(String) : (typeof n?.tags === 'string' ? [n.tags] : []);
    if (tags.includes('BHC') && note.includes(ref)) return String(n?.id || '') || null;
  }
  return null;
}

const ORDER_SEARCH = `query($q: String!) {
  orders(first: 100, query: $q, sortKey: CREATED_AT, reverse: true) {
    nodes { id note tags }
  }
}`;

// H1(b): find a still-live order a prior attempt already created in the store.
// Narrow by the buyer email when present (a buyer has ~never got two BHC orders
// in one store), else fall back to the BHC tag. Best-effort — the caller treats
// any throw/miss as "not found" and falls through to create (the idempotency
// header is the backstop).
async function findExistingBhcOrder(cfg: IntegrationConfig, orderRef: string, buyerEmail: string): Promise<string | null> {
  const q = buyerEmail ? `tag:BHC email:${JSON.stringify(buyerEmail)}` : `tag:BHC`;
  const { status, body } = await gql(cfg, ORDER_SEARCH, { q });
  if (status !== 200) return null;
  const nodes = body?.data?.orders?.nodes;
  return matchExistingBhcOrder(Array.isArray(nodes) ? nodes : [], orderRef);
}

export function classifyGqlErrors(payload: any, httpStatus: number): { permanent: boolean; error: string } {
  if (httpStatus === 429 || httpStatus >= 500) return { permanent: false, error: `http ${httpStatus}` };
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) return { permanent: true, error: `http ${httpStatus} (token/scope/shop)` };
  const ue = payload?.userErrors;
  if (Array.isArray(ue) && ue.length) return { permanent: true, error: ue.map((e: any) => e.message).join('; ').slice(0, 300) };
  return { permanent: false, error: `unclassified http ${httpStatus}` };
}

export function splitShipTo(blob: string): { address1: string; address2?: string; city?: string; provinceCode?: string; zip?: string } {
  // Input is written by productSettlement.formatShipping:
  //   name \n line1 [\n line2] \n "City, ST, 12345"  (state+zip comma OR
  //   space separated — accept both). 2 lines = name absent (rare).
  const lines = String(blob || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const m = lines[lines.length - 1]?.match(/^(.+?),\s*([A-Za-z]{2}),?\s+(\d{5}(?:-\d{4})?)$/);
  if (lines.length >= 2 && m) {
    const street = lines.slice(lines.length === 2 ? 0 : 1, lines.length - 1);
    return { address1: street[0] || lines[0], address2: street[1], city: m[1], provinceCode: m[2].toUpperCase(), zip: m[3] };
  }
  return { address1: lines.join(', ') || String(blob || '') };
}

const VARIANT_BY_SKU = `query($q: String!) { productVariants(first: 1, query: $q) { nodes { id sku } } }`;

async function resolveVariantId(cfg: IntegrationConfig, sku: string): Promise<string | null> {
  const { status, body } = await gql(cfg, VARIANT_BY_SKU, { q: `sku:${JSON.stringify(sku)}` });
  if (status !== 200) return null;
  const node = body?.data?.productVariants?.nodes?.[0];
  return node && node.sku === sku ? String(node.id) : null;
}

const ORDER_CREATE = `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    userErrors { field message }
    order { id name }
  }
}`;

const ORDER_CANCEL = `mutation($orderId: ID!, $restock: Boolean!, $reason: OrderCancelReason!, $staffNote: String, $notifyCustomer: Boolean) {
  orderCancel(orderId: $orderId, restock: $restock, reason: $reason, staffNote: $staffNote, notifyCustomer: $notifyCustomer) {
    job { id }
    orderCancelUserErrors { message }
  }
}`;

export const shopifyConnector: FulfillmentConnector = {
  provider: 'shopify',

  async validateConfig(cfg) {
    const { status, body } = await gql(cfg, `query { shop { name currencyCode } }`, {});
    if (status !== 200 || !body?.data?.shop?.name) {
      return { ok: false, detail: `shop query failed (http ${status}) — check domain + Admin token + read scopes` };
    }
    return { ok: true, detail: `connected to "${body.data.shop.name}" (${body.data.shop.currencyCode})` };
  },

  async pushOrder(cfg, order): Promise<PushResult> {
    // H1(b) PRE-CREATE DEDUP: a prior attempt may have created this order in the
    // store but lost the response (504) — so the row stayed blank and the net
    // cron is re-pushing. Find that order (BHC tag + this orderRef in the note)
    // and short-circuit, so a retry never creates a SECOND live order (double
    // physical ship + double inventory decrement). Best-effort — any search
    // failure falls through to create; the Idempotency-Key header is the backstop.
    try {
      const existing = await findExistingBhcOrder(cfg, order.orderRef, order.buyerEmail);
      if (existing) return { ok: true, externalOrderId: existing };
    } catch { /* search failed — fall through to create (idempotency header guards) */ }

    // Resolve every SKU first — a miss is PERMANENT (operator must fix SKU).
    const lineItems: any[] = [];
    for (const li of order.lineItems) {
      const variantId = await resolveVariantId(cfg, li.sku);
      if (!variantId) return { ok: false, permanent: true, error: `SKU not found in store: ${li.sku}` };
      lineItems.push({ variantId, quantity: li.quantity });
    }
    const ship = splitShipTo(order.shipToAddress);
    const [firstName, ...rest] = order.buyerName.trim().split(/\s+/);
    // H1(a): stable idempotency key so a retried create (lost response) is
    // deduped by Shopify rather than shipping twice.
    const { status, body } = await gql(cfg, ORDER_CREATE, {
      order: {
        lineItems,
        financialStatus: 'PAID',
        sourceName: 'BuyHalfCow',
        tags: ['BHC'],
        note: `BuyHalfCow order ${order.orderRef} — paid via BHC, fulfill as normal.`,
        email: order.buyerEmail,
        shippingAddress: {
          firstName: firstName || order.buyerName, lastName: rest.join(' ') || undefined,
          address1: ship.address1, address2: ship.address2,
          city: ship.city, provinceCode: ship.provinceCode, zip: ship.zip, countryCode: 'US',
        },
      },
      options: {
        inventoryBehaviour: 'DECREMENT_OBEYING_POLICY',
        sendReceipt: false,           // BHC already sent product_receipt
        sendFulfillmentReceipt: true, // Shopify owns the tracking email (Ben decision)
      },
    }, { 'Idempotency-Key': orderIdempotencyKey(order.orderRef) });
    const payload = body?.data?.orderCreate;
    const oid = payload?.order?.id;
    if (status === 200 && oid && !(payload?.userErrors?.length)) return { ok: true, externalOrderId: String(oid) };
    const cls = classifyGqlErrors(payload, status);
    return { ok: false, ...cls };
  },

  async cancelOrder(cfg, externalOrderId, staffNote) {
    const { status, body } = await gql(cfg, ORDER_CANCEL, {
      orderId: externalOrderId, restock: true, reason: 'OTHER',
      staffNote: staffNote.slice(0, 255), notifyCustomer: false,
    });
    const errs = body?.data?.orderCancel?.orderCancelUserErrors;
    if (status === 200 && !(errs?.length)) return { ok: true };
    return { ok: false, error: (errs?.map((e: any) => e.message).join('; ') || `http ${status}`).slice(0, 300) };
  },
};
