// Pure gate + mapper between a Rancher Orders row and the connector's
// PushOrderInput. Deposit-style / pickup nature lives ONLY in the
// 'Order Ref' prefix (same source lib/productFulfillmentSla.ts orderKind
// reads) — those orders must NEVER reach an external store: a deposit is
// not a shippable SKU and a pickup needs no logistics.

import type { IntegrationConfig, PushOrderInput } from './fulfillmentConnector';

export function selectPushableOrder(input: {
  order: any; product: any; integration: IntegrationConfig | null;
}): { ok: true } | { ok: false; reason: string } {
  const { order, product, integration } = input;
  if (!integration) return { ok: false, reason: 'no-integration' };
  // Exact settlement markers ('DEPOSIT — ' / 'PICKUP — ', em-dash included —
  // see productSettlement's Order Ref template). A bare prefix match would
  // false-positive on a product legitimately NAMED "Deposit..." (audit
  // 2026-07-21).
  const ref = String(order?.['Order Ref'] || '');
  if (ref.startsWith('DEPOSIT — ')) return { ok: false, reason: 'deposit-style' };
  if (ref.startsWith('PICKUP — ') || ref.startsWith('DEPOSIT — PICKUP — ')) return { ok: false, reason: 'pickup' };
  if (String(order?.Status || order?.['Status'] || '') !== 'New') return { ok: false, reason: `status-${order?.Status || order?.['Status'] || 'blank'}` };
  if (String(order?.['External Order Id'] || '').trim()) return { ok: false, reason: 'already-pushed' };
  if (String(order?.['External Push Status'] || '').trim() === 'pushed') return { ok: false, reason: 'already-pushed' };
  if (!String(product?.['External SKU'] || '').trim()) return { ok: false, reason: 'no-sku' };
  if (!String(order?.['Ship To Address'] || '').trim()) return { ok: false, reason: 'no-address' };
  return { ok: true };
}

export function buildPushInput(order: any, product: any): PushOrderInput {
  return {
    orderRef: String(order['Order Ref'] || order.id),
    buyerName: String(order['Buyer Name'] || 'Customer'),
    buyerEmail: String(order['Buyer Email'] || ''),
    shipToAddress: String(order['Ship To Address'] || ''),
    lineItems: [{
      sku: String(product['External SKU']).trim(),
      quantity: Math.max(1, Number(order['Quantity'] || 1)),
      title: String(product['Product Name'] || 'Product'),
    }],
  };
}
