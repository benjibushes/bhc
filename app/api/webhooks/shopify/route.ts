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
              // Pull their synced listings off /shop BEFORE clearing the
              // config — a redacted store has no fulfillment rail, and rows
              // left Active kept selling with frozen stock (audit 2026-07-21).
              // Backstop for stores connected before APP_UNINSTALLED existed.
              try {
                const { deactivateSyncManagedProducts } = await import('@/lib/shopifyCatalogSync');
                const pulled = await deactivateSyncManagedProducts(String(rr.id));
                if (pulled > 0) {
                  const { sendOperatorSignal } = await import('@/lib/operatorSignal');
                  await sendOperatorSignal({
                    urgency: 'loud',
                    kind: 'system-error',
                    summary: `Store redacted — ${shop}: ${pulled} listing${pulled === 1 ? '' : 's'} pulled off /shop`,
                    detail: `Shopify sent shop/redact (app uninstalled ~48h ago). Integration config cleared; ${pulled} sync-managed products deactivated.`,
                    dedupeKey: `shopify-redact-${shop}`,
                    dedupeWindowMs: 24 * 60 * 60 * 1000,
                  }).catch(() => {});
                }
              } catch (e: any) {
                console.error('[shopify-webhook] shop/redact listing pull error:', e?.message);
              }
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

    // Real-time uninstall (registered at connect time): the token is revoked
    // the moment the store owner removes the app, so every later push/sync
    // fails — pull the synced listings NOW, clear the config, and ring Ben
    // (buyers were paying for products with no fulfillment rail, audit
    // 2026-07-21). Signed with the same secret as the other topics: the
    // config still holds it at delivery time.
    if (topic === 'app/uninstalled') {
      let pulled = 0;
      try {
        const { deactivateSyncManagedProducts } = await import('@/lib/shopifyCatalogSync');
        pulled = await deactivateSyncManagedProducts(String(rancher.id));
      } catch (e: any) {
        console.error('[shopify-webhook] uninstall listing pull error:', e?.message);
      }
      await updateRecord(TABLES.RANCHERS, rancher.id, { 'Fulfillment Integration': '' }).catch(() => {});
      try {
        const { sendOperatorSignal } = await import('@/lib/operatorSignal');
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'system-error',
          summary: `Store UNINSTALLED — ${shop}: ${pulled} listing${pulled === 1 ? '' : 's'} pulled off /shop`,
          detail:
            `${String(rancher['Ranch Name'] || rancher['Operator Name'] || shop)} removed the BuyHalfCow app from their Shopify store.\n` +
            `Integration config cleared; ${pulled} sync-managed products deactivated. Orders already paid but not yet pushed will NOT auto-fulfill — check for stuck 'New' orders.`,
          dedupeKey: `shopify-uninstalled-${shop}`,
          dedupeWindowMs: 60 * 60 * 1000,
        });
      } catch { /* best-effort */ }
      return NextResponse.json({ ok: true, processed: topic, pulled });
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
