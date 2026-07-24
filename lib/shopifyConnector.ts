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

// The UNIQUE per-order tag stamped on every pushed order so a retry can find its
// own prior create. Keyed on PushOrderInput.dedupToken (the Rancher Orders record
// id) — NEVER on 'Order Ref', which collides across a repeat buyer's same-product
// orders and would make the 2nd order short-circuit onto the 1st (under-ship).
export function bhcOrderTag(dedupToken: string): string {
  return `BHC-oid:${String(dedupToken || '').trim()}`;
}

// H1(a): a STABLE, UNIQUE per-order idempotency key. orderCreate is not naturally
// idempotent — a lost 504 response makes the net cron re-push and ships a SECOND
// live order. Derived from the unique dedupToken (row id): identical on every
// retry of the SAME order (Shopify dedupes the repeat create) but DISTINCT across
// two orders that happen to share an Order Ref (they must both ship).
export function orderIdempotencyKey(dedupToken: string): string {
  return 'bhc-' + createHash('sha256').update(String(dedupToken || '')).digest('hex').slice(0, 40);
}

// H1(b): pre-create dedup decision (pure). Return the id of the store order that
// already carries THIS order's unique `BHC-oid:<dedupToken>` tag (case-
// insensitive — Shopify treats tags case-insensitively), else null. A blank
// dedupToken never matches — we must never false-short-circuit a real order onto
// an unrelated one, nor collide two blank-token orders.
export function matchExistingBhcOrder(
  nodes: Array<{ id?: unknown; tags?: unknown }>,
  dedupToken: string,
): string | null {
  const token = String(dedupToken || '').trim();
  if (!token) return null;
  const want = bhcOrderTag(token).toLowerCase();
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const tags = Array.isArray(n?.tags) ? n.tags.map((t) => String(t)) : (typeof n?.tags === 'string' ? [n.tags] : []);
    if (tags.some((t) => t.trim().toLowerCase() === want)) return String(n?.id || '') || null;
  }
  return null;
}

const ORDER_SEARCH = `query($q: String!) {
  orders(first: 10, query: $q, sortKey: CREATED_AT, reverse: true) {
    nodes { id tags }
  }
}`;

// H1(b): find a still-live order a prior attempt already created in the store,
// by this order's UNIQUE dedup tag. Best-effort — the caller treats any throw/
// miss as "not found" and falls through to create (the idempotency header is the
// backstop). A blank dedupToken skips the search (never dedup on an empty key).
async function findExistingBhcOrder(cfg: IntegrationConfig, dedupToken: string): Promise<string | null> {
  const token = String(dedupToken || '').trim();
  if (!token) return null;
  const { status, body } = await gql(cfg, ORDER_SEARCH, { q: `tag:${JSON.stringify(bhcOrderTag(token))}` });
  if (status !== 200) return null;
  const nodes = body?.data?.orders?.nodes;
  return matchExistingBhcOrder(Array.isArray(nodes) ? nodes : [], token);
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
    // cron is re-pushing. Find that order by its UNIQUE `BHC-oid:<dedupToken>`
    // tag and short-circuit, so a retry never creates a SECOND live order (double
    // physical ship + double inventory decrement). Keyed on the unique token, so
    // a repeat buyer's identical-Order-Ref order is NOT falsely matched (it must
    // ship). Best-effort — any search failure falls through to create; the
    // Idempotency-Key header is the backstop.
    try {
      const existing = await findExistingBhcOrder(cfg, order.dedupToken);
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
    // Tags: keep the plain 'BHC' tag (#468's isBhcOriginOrder / B3 matches it so
    // the orders/create webhook skips BHC-origin orders) AND stamp the UNIQUE
    // `BHC-oid:<dedupToken>` tag the pre-create dedup queries on. Blank token →
    // omit the oid tag (never stamp a colliding blank tag on multiple orders).
    const tags = order.dedupToken ? ['BHC', bhcOrderTag(order.dedupToken)] : ['BHC'];
    // H1(a): stable+unique idempotency key so a retried create (lost response) is
    // deduped by Shopify rather than shipping twice — while two orders sharing an
    // Order Ref stay distinct.
    const { status, body } = await gql(cfg, ORDER_CREATE, {
      order: {
        lineItems,
        financialStatus: 'PAID',
        sourceName: 'BuyHalfCow',
        tags,
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
    }, { 'Idempotency-Key': orderIdempotencyKey(order.dedupToken) });
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
