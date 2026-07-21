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

export function computeDisplayPrice(base: number, markupPercent: number | null): number | null {
  if (markupPercent == null || !Number.isFinite(base) || base <= 0) return null;
  return Math.ceil(base * (1 + markupPercent / 100)) - 0.01;
}

export function mapVariantToProductFields(input: { product: any; variant: any; markupPercent: number | null }): Record<string, any> {
  const { product, variant, markupPercent } = input;
  const base = Number(variant.price || 0);
  const name = variant.title && variant.title !== 'Default Title'
    ? `${product.title} — ${variant.title}`
    : String(product.title || 'Product');
  const qty = Number(variant.inventoryQuantity ?? 0);
  const display = computeDisplayPrice(base, markupPercent);
  return {
    'Product Name': name,
    'External SKU': String(variant.sku || '').trim(),
    'External Product Id': String(product.id || ''),
    'Rancher Base': base,
    ...(display != null ? { 'Display Price': display } : {}),
    'Orders Left': Math.max(0, qty),
    'Active': product.status === 'ACTIVE' && qty > 0,
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
      variants(first: 50) { nodes { id title sku price inventoryQuantity } }
    }
  }
}`;

export interface CatalogSyncResult {
  imported: number;
  updated: number;
  skippedNoSku: number;
  report: string[];
}

export async function syncShopifyCatalog(rancherId: string, opts?: { dryRun?: boolean }): Promise<CatalogSyncResult> {
  const rancher = await getRecordById(TABLES.RANCHERS, rancherId);
  const cfg = parseIntegration(rancher?.['Fulfillment Integration']);
  if (!cfg || cfg.mode !== 'sync') {
    return { imported: 0, updated: 0, skippedNoSku: 0, report: ['not in sync mode'] };
  }
  const rancherName = String(rancher['Ranch Name'] || rancher['Operator Name'] || '');

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
      return { imported, updated, skippedNoSku, report: [`catalog fetch failed on page ${pages + 1} — partial: imported ${imported}, updated ${updated}`] };
    }
    for (const product of page.nodes || []) {
      for (const variant of product.variants?.nodes || []) {
        if (!String(variant.sku || '').trim()) {
          skippedNoSku++;
          continue;
        }
        const fields = mapVariantToProductFields({ product, variant, markupPercent: cfg.markupPercent ?? null });
        const row = bySku.get(fields['External SKU']);
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

  return {
    imported,
    updated,
    skippedNoSku,
    report: [`${opts?.dryRun ? '[dry-run] ' : ''}imported ${imported}, updated ${updated}, no-SKU skipped ${skippedNoSku}`],
  };
}
