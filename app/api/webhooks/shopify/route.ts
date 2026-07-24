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
import { getAllRecords, getFirstRecord, createRecord, updateRecord, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { parseIntegration } from '@/lib/fulfillmentConnector';
import { verifyShopifyHmac } from '@/lib/shopifyWebhookVerify';
import { publicAppCreds, isValidShopDomain } from '@/lib/shopifyOauth';
import { decryptSecret } from '@/lib/integrationCrypto';
import {
  isBhcOriginOrder,
  extractOrderLineItems,
  orderDecrementPatch,
  shopifyOrderEventId,
} from '@/lib/shopifyOrderIngest';
import {
  buildScopedFulfillmentOrderFilter,
  shopifyWebhookRateLimitKey,
  catalogSyncReportIndicatesFailure,
  resolveFulfillmentStampPatch,
} from '@/lib/shopifyWebhookGuards';
import { rateLimitStrict, getTrustedClientIp } from '@/lib/rateLimit';
import { claimOnce } from '@/lib/rancherCapacity';

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

    // ── L6: bound the UNAUTHENTICATED pre-HMAC Airtable full-scan below ───────
    // Everything past this point resolves the rancher by scanning the Ranchers
    // table with an attacker-supplied shop header BEFORE any HMAC check. Two
    // cheap gates cap that cost (compliance topics already HMAC-gate above, so
    // this deliberately sits AFTER them and never touches that path):
    //   (a) format-reject anything that isn't a real *.myshopify.com host, and
    //   (b) a per-source burst cap. Bucketed by TRUSTED client IP (not the
    //       spoofable shop header) via rateLimitStrict, which NEVER fails open
    //       to unbounded — a security control must degrade closed. Shopify
    //       retries non-2xx for ~48h, so a throttled legit event is delayed,
    //       not lost.
    if (!isValidShopDomain(shop)) {
      return NextResponse.json({ ok: false, error: 'invalid shop domain' }, { status: 400 });
    }
    const clientIp = getTrustedClientIp(request);
    const rl = await rateLimitStrict(shopifyWebhookRateLimitKey(clientIp), { requests: 120 });
    if (!rl.ok) {
      console.warn(`[shopify-webhook] rate limited ip=${clientIp} shop=${shop} topic=${topic}`);
      return NextResponse.json({ ok: false, error: 'rate limited' }, { status: 429 });
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
        // L7: a re-sync that FAILS or PARTIALLY fails still returns a report and
        // used to 200 silently — so a store's /shop price/stock froze until the
        // 6h catalog cron caught up, with nobody the wiser. Alert on it. (The
        // TRUNCATED page-cap case fires its own loud signal inside the sync, so
        // catalogSyncReportIndicatesFailure deliberately skips it — no dupe.)
        if (catalogSyncReportIndicatesFailure(res.report)) {
          try {
            const { sendOperatorSignal } = await import('@/lib/operatorSignal');
            await sendOperatorSignal({
              urgency: 'normal',
              kind: 'system-error',
              summary: `Shopify catalog re-sync partial/failed — ${shop}`,
              detail:
                `A ${topic} webhook triggered a catalog re-sync that did not fully succeed for ` +
                `${String(rancher['Ranch Name'] || rancher['Operator Name'] || shop)}. /shop price/stock may be stale until the 6h catalog cron reconciles.\n\n` +
                res.report.join('; '),
              dedupeKey: `shopify-catalog-sync-fail-${shop}`,
              dedupeWindowMs: 60 * 60 * 1000,
            }).catch(() => {});
          } catch { /* alerting is best-effort */ }
        }
        return NextResponse.json({ ok: true, processed: topic, sync: res.report.join('; ') });
      } catch (e: any) {
        // A hard throw is the loudest swallow of all — the old code 200'd with a
        // `sync: failed:` blob nobody reads. Ring the same deduped beacon.
        console.error('[shopify-webhook] products sync threw:', e?.message);
        try {
          const { sendOperatorSignal } = await import('@/lib/operatorSignal');
          await sendOperatorSignal({
            urgency: 'normal',
            kind: 'system-error',
            summary: `Shopify catalog re-sync FAILED — ${shop}`,
            detail:
              `A ${topic} webhook triggered a catalog re-sync that threw for ` +
              `${String(rancher['Ranch Name'] || rancher['Operator Name'] || shop)}. /shop price/stock may be stale until the 6h catalog cron reconciles.\n\n` +
              `Error: ${String(e?.message || 'unknown').slice(0, 200)}`,
            dedupeKey: `shopify-catalog-sync-fail-${shop}`,
            dedupeWindowMs: 60 * 60 * 1000,
          }).catch(() => {});
        } catch { /* alerting is best-effort */ }
        return NextResponse.json({ ok: true, processed: topic, sync: `failed: ${String(e?.message || '').slice(0, 100)}` });
      }
    }

    // Real-time inventory (B3): a DIRECT sale on the rancher's OWN store must
    // decrement BHC 'Orders Left' NOW — otherwise /shop can oversell for up to
    // 6h until the catalog cron / products/update webhook catches up.
    if (topic === 'orders/create') {
      let payload: any;
      try {
        payload = JSON.parse(raw);
      } catch {
        return NextResponse.json({ ok: true, skipped: 'bad json' });
      }
      // LANDMINE 1: BHC's OWN pushed orders ALSO fire orders/create, and they
      // already decremented 'Orders Left' at settlement — decrementing again
      // double-counts. Skip anything carrying the BHC source/tag markers.
      if (isBhcOriginOrder(payload)) {
        return NextResponse.json({ ok: true, skipped: 'bhc-origin (already decremented at settlement)' });
      }
      const lineItems = extractOrderLineItems(payload);
      if (lineItems.length === 0) {
        return NextResponse.json({ ok: true, processed: topic, decremented: 0, note: 'no SKU line items' });
      }

      // LANDMINE 2: IDEMPOTENCY. Shopify redelivers webhooks and decrement is
      // not naturally idempotent. Two layers, mirroring the money webhooks:
      //   • claimOnce (Redis SET NX) closes the tight concurrent-redelivery race
      //     (degrades OPEN when Redis is absent — same as settlement).
      //   • the DURABLE 'Stripe Events' table, keyed on the STABLE Shopify order
      //     id, survives Redis absence + Shopify's up-to-48h redelivery window.
      const eventId = shopifyOrderEventId(shop, payload);
      const gotClaim = await claimOnce(`shopify-order-create:${eventId}`, 15 * 60);
      if (!gotClaim) {
        return NextResponse.json({ ok: true, skipped: 'in-flight duplicate' });
      }
      const safeEventId = escapeAirtableValue(eventId);
      try {
        const existing = await getFirstRecord('Stripe Events', `{Event Id} = "${safeEventId}"`);
        if (existing && existing['Status'] === 'processed') {
          return NextResponse.json({ ok: true, skipped: 'duplicate order event' });
        }
        if (!existing) {
          await createRecord('Stripe Events', {
            'Event Id': eventId,
            'Event Type': 'shopify/orders/create',
            'Account Id': shop,
            'Received At': new Date().toISOString(),
            'Status': 'received',
          });
        }
      } catch (e: any) {
        // Durable guard unavailable — do NOT decrement blind (a later redelivery
        // would double-count with nothing to dedupe against). claimOnce already
        // covered the tight race; bail SAFE and let the catalog cron reconcile.
        console.error('[shopify-webhook] orders/create idempotency store unavailable, skipping decrement:', e?.message);
        return NextResponse.json({ ok: true, skipped: 'idempotency store unavailable' });
      }

      // Decrement each SKU's Rancher Products row, scoped to THIS rancher (a SKU
      // can collide across stores). orderDecrementPatch leaves unlimited stock
      // untouched, floors at 0, and flips Active off at 0 (never on).
      let decremented = 0;
      const touchedIds = new Set<string>();
      for (const li of lineItems) {
        try {
          const rows = (await getAllRecords(
            TABLES.RANCHER_PRODUCTS,
            `AND({Rancher Record ID} = "${escapeAirtableValue(String(rancher.id))}", {External SKU} = "${escapeAirtableValue(li.sku)}")`,
          ).catch(() => [])) as any[];
          for (const row of rows) {
            const patch = orderDecrementPatch(row['Orders Left'], li.quantity);
            if (patch) {
              await updateRecord(TABLES.RANCHER_PRODUCTS, row.id, patch).catch(() => {});
              decremented++;
              touchedIds.add(String(row.id));
            }
          }
        } catch (e: any) {
          console.error('[shopify-webhook] orders/create decrement error:', e?.message);
        }
      }

      // Flip the durable marker to 'processed' LAST — a crash before this leaves
      // it 'received' so a retry re-processes; the residual off-by-one window is
      // the one settlement already tolerates (Airtable has no atomic decrement)
      // and self-corrects at the monthly stock check-in.
      try {
        const evRow = await getFirstRecord('Stripe Events', `{Event Id} = "${safeEventId}"`);
        if (evRow) await updateRecord('Stripe Events', evRow.id, { 'Status': 'processed' }).catch(() => {});
      } catch { /* best-effort */ }

      if (touchedIds.size > 0) {
        try {
          const { revalidatePath } = await import('next/cache');
          revalidatePath('/shop');
          for (const id of touchedIds) revalidatePath(`/shop/${id}`);
        } catch { /* ISR backstop */ }
      }
      return NextResponse.json({ ok: true, processed: topic, decremented });
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

    // L5: scope the lookup to THIS HMAC-verified rancher. Finding the order by
    // External Order Id ALONE meant a rancher whose HMAC verified could stamp
    // ANOTHER rancher's order row that happened to share the same order id
    // (order ids are per-store, so a collision across two connected stores is
    // possible). AND-combine with the rancher we already resolved + verified.
    const orders = (await getAllRecords(
      TABLES.RANCHER_ORDERS,
      buildScopedFulfillmentOrderFilter(externalOrderId, String(rancher.id)),
    ).catch(() => [])) as any[];
    let touched = 0;
    let stampFailed = false;
    const nowIso = new Date().toISOString();
    for (const order of orders) {
      // L8: on fulfillments/update, a corrected tracking number OVERWRITES the
      // stored one (a rancher who fixes a typo in Shopify must propagate);
      // fulfillments/create still only fills an empty value.
      const updates = resolveFulfillmentStampPatch({
        topic,
        incomingTracking: tracking,
        currentTracking: order['Tracking Number'],
        currentStatus: order['Status'],
        nowIso,
      });
      if (Object.keys(updates).length) {
        // L9: the stamp write was fire-and-forget (.catch(()=>{})), so a failed
        // stamp was invisible — #468's B2 health check would only notice 48h
        // later, and blame the wrong thing. Make a failure log + ring a deduped
        // beacon so a persistently failing tracking-back is caught fast. Still
        // 200 to Shopify (don't trigger a retry storm on a transient Airtable
        // blip — the beacon carries the signal instead).
        try {
          await updateRecord(TABLES.RANCHER_ORDERS, order.id, updates);
          touched++;
        } catch (e: any) {
          stampFailed = true;
          console.error(`[shopify-webhook] tracking stamp write FAILED for order=${order.id} shop=${shop}:`, e?.message);
        }
      }
    }
    if (stampFailed) {
      try {
        const { sendOperatorSignal } = await import('@/lib/operatorSignal');
        await sendOperatorSignal({
          urgency: 'normal',
          kind: 'system-error',
          summary: `Shopify tracking stamp FAILED to write — ${shop}`,
          detail:
            `A ${topic} webhook matched a Rancher Orders row but the Tracking Number / Status='Shipped' stamp write to Airtable failed for ` +
            `${String(rancher['Ranch Name'] || rancher['Operator Name'] || shop)} (order ${externalOrderId}). ` +
            `The buyer's SLA chase won't stop and B2's tracking-back health check will trip in 48h — check Airtable write health now.`,
          dedupeKey: `shopify-tracking-stamp-fail-${shop}`,
          dedupeWindowMs: 60 * 60 * 1000,
        }).catch(() => {});
      } catch { /* alerting is best-effort */ }
    }
    return NextResponse.json({ ok: true, processed: topic, matched: orders.length, touched });
  } catch (error: any) {
    // Match the Resend webhook posture: never 5xx-loop on our own bug.
    console.error('[shopify-webhook] error:', error?.message);
    return NextResponse.json({ ok: true, error: String(error?.message || 'unknown') });
  }
}
