// Sync-mode import: rancher's Shopify catalog → Rancher Products rows.
// Dedupe key = (Rancher Record ID, External SKU). 'Sync Managed' marks rows
// this engine owns — it NEVER touches hand-created rows, and hand edits to
// Display Price survive when markupPercent is null (sync then only imports
// price on first create). Variants without a SKU are skipped (reported) —
// SKU is the join key for the order push.
//
// Pricing: Rancher Base = the distributor's own store price (what they net,
// matching the product rail's payout math); Display Price = BHC resale =
// ceil(base × (1+markup%)) − .01. BHC margin is taken upfront at charge time
// by the existing rail — sync just sets the numbers it reads.

import { getAllRecords, createRecord, updateRecord, getRecordById, TABLES, escapeAirtableValue } from './airtable';
import { parseIntegration } from './fulfillmentConnector';
import { decryptSecret } from './integrationCrypto';
import { claimOnce } from './rancherCapacity';

export function computeDisplayPrice(base: number, markupPercent: number | null): number | null {
  if (markupPercent == null || !Number.isFinite(base) || base <= 0) return null;
  return Math.ceil(base * (1 + markupPercent / 100)) - 0.01;
}

export function mapVariantToProductFields(input: {
  product: any;
  variant: any;
  markupPercent: number | null;
  /**
   * CURATION GATE (2026-07-21, Ben decision): a synced product only displays
   * on /shop once Ben checks 'Marketplace Approved' on its row. Active is
   * COMPUTED — approved AND in-stock AND store-ACTIVE — so approval is a
   * one-time human call while stock/status flaps stay automatic. New rows
   * import unapproved (Active false, never on the marketplace unseen).
   */
  approved: boolean;
}): Record<string, any> {
  const { product, variant, markupPercent, approved } = input;
  const base = Number(variant.price || 0);
  const name = variant.title && variant.title !== 'Default Title'
    ? `${product.title} — ${variant.title}`
    : String(product.title || 'Product');
  // Untracked / continue-selling stores (made-to-order boxes, print-on-demand
  // merch) report inventoryQuantity 0 forever — without this, every row
  // imports with Orders Left 0 and can NEVER display, even after Ben approves
  // it (audit 2026-07-21: silent stall, no report line explains why).
  const alwaysInStock =
    variant?.inventoryItem?.tracked === false || variant?.inventoryPolicy === 'CONTINUE';
  const qty = alwaysInStock ? 999 : Number(variant.inventoryQuantity ?? 0);
  const display = computeDisplayPrice(base, markupPercent);
  return {
    'Product Name': name,
    'External SKU': String(variant.sku || '').trim(),
    'External Product Id': String(product.id || ''),
    'Rancher Base': base,
    ...(display != null ? { 'Display Price': display } : {}),
    'Orders Left': Math.max(0, qty),
    'Active': approved && product.status === 'ACTIVE' && qty > 0,
    'Sync Managed': true,
    'Last Synced At': new Date().toISOString(),
    ...(product?.featuredMedia?.preview?.image?.url ? { 'Image URL': String(product.featuredMedia.preview.image.url) } : {}),
    ...(product?.description ? { 'Description': String(product.description).slice(0, 2000) } : {}),
  };
}

const PRODUCTS_PAGE = `query($cursor: String) {
  products(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title status description
      featuredMedia { preview { image { url } } }
      variants(first: 50) { nodes { id title sku price inventoryQuantity inventoryPolicy inventoryItem { tracked } } }
    }
  }
}`;

// Mirror of the rancher self-serve SHARE FENCE (lib/rancherProductInput.ts):
// whole/half/quarter shares sell through the qualified deposit rail, never as
// one-click /shop products — a synced Shopify product named "Half Beef Share"
// must not bypass the gate the hand-entry path enforces. (Audit 2026-07-21:
// sync wrote fields directly and skipped every input guard.)
const SHARE_FENCE_RE = /\b(whole|half|quarter)\s*[- ]?\s*(beef|cow|share|steer|animal)s?\b/i;
const MIN_SYNC_PRICE = 5; // dollars — mirrors MIN_PRODUCT_PRICE_CENTS

export interface CatalogSyncResult {
  imported: number;
  updated: number;
  skippedNoSku: number;
  skippedGuard: number;
  deactivated: number;
  report: string[];
}

// Uninstall / redact cleanup: pull every sync-managed listing this rancher
// has off /shop (Active=false). Only rows this engine owns — hand-created
// rows are never touched. Returns the count pulled.
export async function deactivateSyncManagedProducts(rancherId: string): Promise<number> {
  const rows = (await getAllRecords(
    TABLES.RANCHER_PRODUCTS,
    `AND({Rancher Record ID} = "${escapeAirtableValue(rancherId)}", {Sync Managed} = TRUE(), {Active} = TRUE())`,
  ).catch(() => [])) as any[];
  let pulled = 0;
  for (const row of rows) {
    await updateRecord(TABLES.RANCHER_PRODUCTS, row.id, {
      'Active': false,
      'Last Synced At': new Date().toISOString(),
    }).catch(() => {});
    pulled++;
  }
  return pulled;
}

export async function syncShopifyCatalog(rancherId: string, opts?: { dryRun?: boolean }): Promise<CatalogSyncResult> {
  const rancher = await getRecordById(TABLES.RANCHERS, rancherId);
  const cfg = parseIntegration(rancher?.['Fulfillment Integration']);
  if (!cfg || cfg.mode !== 'sync') {
    return { imported: 0, updated: 0, skippedNoSku: 0, skippedGuard: 0, deactivated: 0, report: ['not in sync mode'] };
  }
  const rancherName = String(rancher['Ranch Name'] || rancher['Operator Name'] || '');

  // Per-rancher concurrency guard (real writes only): a webhook-triggered sync
  // and the scheduled catalog cron can fire for the same rancher near-
  // simultaneously. Both read the same `existing` bySku map, neither sees the
  // other's just-created rows, and each createRecord's the same (rancher, SKU)
  // → duplicate rows on /shop. Serialize with a short claimOnce lock; if a run
  // is already in flight, skip — it imports the same catalog. dryRun previews
  // never write, so they don't contend.
  if (!opts?.dryRun) {
    const gotLock = await claimOnce(`shopify-sync-${rancherId}`, 30);
    if (!gotLock) {
      return { imported: 0, updated: 0, skippedNoSku: 0, skippedGuard: 0, deactivated: 0, report: ['skipped — a sync for this rancher is already in progress'] };
    }
  }

  const existing = (await getAllRecords(
    TABLES.RANCHER_PRODUCTS,
    `{Rancher Record ID} = "${escapeAirtableValue(rancherId)}"`,
  )) as any[];
  const bySku = new Map(
    existing
      .filter((r) => String(r['External SKU'] || '').trim())
      .map((r) => [String(r['External SKU']).trim(), r]),
  );

  let imported = 0;
  let updated = 0;
  let skippedNoSku = 0;
  let skippedGuard = 0;
  // Every SKU present in the store THIS run (guard-blocked ones included) —
  // rows whose SKU is absent from this set after a COMPLETE pagination run
  // no longer exist in the store and get pulled off /shop.
  const seenSkus = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res: any = await fetch(`https://${cfg.shop}/admin/api/2026-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': decryptSecret(cfg.encToken),
      },
      body: JSON.stringify({ query: PRODUCTS_PAGE, variables: { cursor } }),
    }).then((r) => r.json()).catch(() => null);
    const page = res?.data?.products;
    if (!page) {
      return { imported, updated, skippedNoSku, skippedGuard, deactivated: 0, report: [`catalog fetch failed on page ${pages + 1} — partial: imported ${imported}, updated ${updated}`] };
    }
    for (const product of page.nodes || []) {
      for (const variant of product.variants?.nodes || []) {
        if (!String(variant.sku || '').trim()) {
          skippedNoSku++;
          continue;
        }
        const skuKey = String(variant.sku || '').trim();
        seenSkus.add(skuKey);
        // Guardrails the hand-entry path enforces (share fence + $5 floor) —
        // synced rows must not bypass them.
        const candidateName = `${product.title || ''} ${variant.title || ''}`;
        if (SHARE_FENCE_RE.test(candidateName) || Number(variant.price || 0) < MIN_SYNC_PRICE) {
          skippedGuard++;
          continue;
        }
        const row = bySku.get(skuKey);
        const fields = mapVariantToProductFields({
          product,
          variant,
          markupPercent: cfg.markupPercent ?? null,
          approved: row?.['Marketplace Approved'] === true,
        });
        // First-create price safety (audit 2026-07-21): a null markup left
        // 'Display Price' unwritten FOREVER — an approved row was then
        // invisible on /shop and 409'd at buy. On create, default the resale
        // price to the store price (zero-margin listing Ben can re-price);
        // updates still leave a hand-set price alone.
        if (!('Display Price' in fields) && !row) {
          (fields as any)['Display Price'] = fields['Rancher Base'];
        }
        // Section routing: a config-level Category (e.g. 'Merch') keeps this
        // store's products in their own /shop section.
        if (cfg.category) (fields as any)['Category'] = cfg.category;
        if (opts?.dryRun) {
          if (row) updated++;
          else imported++;
          continue;
        }
        if (row) {
          // Only rows this engine owns — a hand-created row with a matching
          // SKU keeps Ben's numbers (link happens via SKU alone).
          if (row['Sync Managed'] === true) {
            await updateRecord(TABLES.RANCHER_PRODUCTS, row.id, fields);
            updated++;
          }
        } else {
          await createRecord(TABLES.RANCHER_PRODUCTS, {
            ...fields,
            'Rancher Record ID': rancherId,
            'Rancher Name': rancherName,
          });
          imported++;
        }
      }
    }
    cursor = page.pageInfo?.hasNextPage ? String(page.pageInfo.endCursor) : null;
    pages++;
  } while (cursor && pages < 40); // 40×50 products = plenty; hard stop vs pagination bugs

  // Store-truth reconciliation (audit 2026-07-21): a product deleted in
  // Shopify (or a renamed SKU) left its row Active forever — /shop kept
  // selling it and the push failed AFTER the buyer paid. Deactivate
  // sync-managed rows whose SKU no longer exists in the store — but ONLY
  // after a COMPLETE pagination run (cursor drained; never the partial-fetch
  // bail above or the 40-page cap), or a transient fetch failure would pull
  // a healthy catalog off /shop.
  let deactivated = 0;
  if (cursor === null) {
    for (const [sku, row] of bySku) {
      if (seenSkus.has(sku)) continue;
      if (row['Sync Managed'] !== true || row['Active'] !== true) continue;
      if (!opts?.dryRun) {
        await updateRecord(TABLES.RANCHER_PRODUCTS, row.id, {
          'Active': false,
          'Last Synced At': new Date().toISOString(),
        }).catch(() => {});
      }
      deactivated++;
    }
  }

  return {
    imported,
    updated,
    skippedNoSku,
    skippedGuard,
    deactivated,
    report: [
      `${opts?.dryRun ? '[dry-run] ' : ''}imported ${imported}, updated ${updated}, no-SKU skipped ${skippedNoSku}` +
        (skippedGuard ? `, guard-blocked ${skippedGuard} (share-fence/$5 floor)` : '') +
        (deactivated ? `, pulled ${deactivated} (SKU gone from store)` : ''),
    ],
  };
}
