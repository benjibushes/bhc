// POST /api/webhooks/shopify — fulfillment events from connected stores.
// Topics: fulfillments/create, fulfillments/update (registered at connect
// time by /connectstore). HMAC = the custom app's API secret (per-rancher,
// encrypted in Fulfillment Integration). Shop resolved from
// X-Shopify-Shop-Domain, rancher found via FIND(shop) over the JSON field.
//
// Stamps: Tracking Number / Shipped At / Status 'Shipped' — idempotent.
// Deliberately does NOT send product_shipped: the pushed order was created
// with sendFulfillmentReceipt, so Shopify already emailed the buyer their
// tracking (Ben decision 2026-07-21). The SLA chase stops via Status.
//
// Always 200 on non-actionable input (Shopify retries non-2xx aggressively);
// 401 only on a real HMAC failure.

import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { parseIntegration } from '@/lib/fulfillmentConnector';
import { verifyShopifyHmac } from '@/lib/shopifyWebhookVerify';
import { publicAppCreds } from '@/lib/shopifyOauth';
import { decryptSecret } from '@/lib/integrationCrypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const shop = String(request.headers.get('x-shopify-shop-domain') || '').toLowerCase().trim();
    const topic = String(request.headers.get('x-shopify-topic') || '');
    if (!shop) return NextResponse.json({ ok: true, skipped: 'no shop header' });

    // MANDATORY COMPLIANCE TOPICS (public app, Phase 2): customers/data_request,
    // customers/redact, shop/redact. Shopify's review sends these with the
    // PUBLIC app's secret and requires: valid HMAC → 200, invalid → 401 —
    // regardless of whether we know the shop. We hold no store-customer PII
    // (buyers are BHC's, not theirs), so data_request/redact are acknowledge-
    // only; shop/redact clears the shop's integration config (app uninstalled
    // + store data purge requested).
    const COMPLIANCE_TOPICS = new Set(['customers/data_request', 'customers/redact', 'shop/redact']);
    if (COMPLIANCE_TOPICS.has(topic)) {
      const creds = publicAppCreds();
      const sig = request.headers.get('x-shopify-hmac-sha256');
      const okSig = creds ? verifyShopifyHmac(raw, sig, creds.clientSecret) : false;
      if (!okSig) return NextResponse.json({ ok: false, error: 'invalid signature' }, { status: 401 });
      if (topic === 'shop/redact') {
        try {
          const rs = (await getAllRecords(
            TABLES.RANCHERS,
            `FIND("${escapeAirtableValue(shop)}", {Fulfillment Integration})`,
          ).catch(() => [])) as any[];
          const { parseIntegration: pi2 } = await import('@/lib/fulfillmentConnector');
          for (const rr of rs) {
            if (pi2(rr['Fulfillment Integration'])?.shop === shop) {
              await updateRecord(TABLES.RANCHERS, rr.id, { 'Fulfillment Integration': '' }).catch(() => {});
            }
          }
        } catch (e: any) {
          console.error('[shopify-webhook] shop/redact cleanup error:', e?.message);
        }
      }
      console.log(`[shopify-webhook] compliance ${topic} acknowledged for ${shop}`);
      return NextResponse.json({ ok: true, processed: topic });
    }

    const ranchers = (await getAllRecords(
      TABLES.RANCHERS,
      `FIND("${escapeAirtableValue(shop)}", {Fulfillment Integration})`,
    ).catch(() => [])) as any[];
    const rancher = ranchers.find((r) => parseIntegration(r['Fulfillment Integration'])?.shop === shop);
    const integration = rancher ? parseIntegration(rancher['Fulfillment Integration']) : null;
    if (!integration) return NextResponse.json({ ok: true, skipped: 'unknown shop' });

    let secret = '';
    try {
      secret = decryptSecret(integration.encApiSecret);
    } catch {
      console.error(`[shopify-webhook] secret decrypt failed for ${shop}`);
      return NextResponse.json({ ok: true, skipped: 'secret unavailable' });
    }
    if (!verifyShopifyHmac(raw, request.headers.get('x-shopify-hmac-sha256'), secret)) {
      console.warn(`[shopify-webhook] HMAC fail for ${shop} topic=${topic}`);
      return NextResponse.json({ ok: false, error: 'invalid signature' }, { status: 401 });
    }

    // Catalog freshness (sync mode): a product edit in their store re-syncs
    // that rancher's catalog. Full-catalog resync is cheap at these sizes and
    // avoids per-product partial-update bugs.
    if (topic === 'products/update' || topic === 'products/delete') {
      try {
        const { syncShopifyCatalog } = await import('@/lib/shopifyCatalogSync');
        const res = await syncShopifyCatalog(String(rancher.id));
        return NextResponse.json({ ok: true, processed: topic, sync: res.report.join('; ') });
      } catch (e: any) {
        return NextResponse.json({ ok: true, processed: topic, sync: `failed: ${String(e?.message || '').slice(0, 100)}` });
      }
    }

    if (topic !== 'fulfillments/create' && topic !== 'fulfillments/update') {
      return NextResponse.json({ ok: true, skipped: topic || 'no topic' });
    }

    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      return NextResponse.json({ ok: true, skipped: 'bad json' });
    }
    const externalOrderId = payload?.order_id ? `gid://shopify/Order/${payload.order_id}` : '';
    const tracking = String(payload?.tracking_numbers?.[0] || payload?.tracking_number || '').slice(0, 120);
    if (!externalOrderId) return NextResponse.json({ ok: true, skipped: 'no order_id' });

    const orders = (await getAllRecords(
      TABLES.RANCHER_ORDERS,
      `{External Order Id} = "${escapeAirtableValue(externalOrderId)}"`,
    ).catch(() => [])) as any[];
    let touched = 0;
    for (const order of orders) {
      const updates: Record<string, any> = {};
      if (tracking && !String(order['Tracking Number'] || '').trim()) updates['Tracking Number'] = tracking;
      if (String(order['Status'] || '') === 'New') {
        updates['Status'] = 'Shipped';
        updates['Shipped At'] = new Date().toISOString();
      }
      if (Object.keys(updates).length) {
        await updateRecord(TABLES.RANCHER_ORDERS, order.id, updates).catch(() => {});
        touched++;
      }
    }
    return NextResponse.json({ ok: true, processed: topic, matched: orders.length, touched });
  } catch (error: any) {
    // Match the Resend webhook posture: never 5xx-loop on our own bug.
    console.error('[shopify-webhook] error:', error?.message);
    return NextResponse.json({ ok: true, error: String(error?.message || 'unknown') });
  }
}
