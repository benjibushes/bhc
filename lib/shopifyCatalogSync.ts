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
import { claimSyncLock, releaseClaim } from './rancherCapacity';

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
  /**
   * M4 OVERSELL GUARD: units already sold through BHC whose push to the store
   * FAILED (or hasn't run) — Shopify's inventory count still includes them
   * because Shopify was never told. Subtracted from the Shopify count so the
   * 6h sync can't re-shelve a settlement-decremented unit. Only meaningful for
   * an EXISTING row (a first import has no prior settlement) and never applied
   * to unlimited (untracked/continue) stock. Defaults to 0.
   */
  outstandingObligation?: number;
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
  const rawQty = alwaysInStock ? 999 : Number(variant.inventoryQuantity ?? 0);
  // M4: never subtract from unlimited stock (no finite count to oversell);
  // for a tracked count, drop the units Shopify still lists but BHC already
  // sold (unpushed/failed obligations). Both Orders Left AND Active read this
  // adjusted qty so they can't disagree (0 available ⇒ never Active).
  const obligation = alwaysInStock ? 0 : Math.max(0, Math.floor(Number(input.outstandingObligation || 0)));
  const qty = Math.max(0, rawQty - obligation);
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

// Pagination hard stop: 40 pages × 50 products = 2000 SKUs. Beyond this the
// loop bails (L11 fires a truncation signal so it's never silent).
export const CATALOG_PAGE_CAP = 40;

// Per-rancher sync lock TTL. Must be >= the longest single-sync runtime; the
// scheduled cron's maxDuration is 300s (app/api/cron/shopify-catalog-sync),
// the longest-lived caller. The lock is now RELEASED in a finally, so this TTL
// is only the crash-safety backstop — a slow multi-page run must never free
// the lock mid-flight and let a concurrent webhook createRecord duplicates.
export const SYNC_LOCK_TTL_SEC = 300;

// H3: does this product/variant trip a guard the hand-entry path enforces
// (share fence OR sub-$5 floor)? A guard-blocked SKU must NEVER live on the
// one-click /shop rail — whole/half/quarter beef belongs to the deposit rail.
export function tripsShareGuard(name: string, price: number): boolean {
  return SHARE_FENCE_RE.test(name) || Number(price || 0) < MIN_SYNC_PRICE;
}

// H3: when a SKU trips the guard, decide what to do with any existing row it
// maps to. A row that WAS live and Sync Managed (e.g. the rancher renamed it
// "Half Beef" or repriced below $5 after it went live) must be DELISTED —
// otherwise it stays on /shop, defeating the share fence. Hand-created rows
// (Sync Managed !== true) are never touched; already-inactive rows need nothing.
export function guardBlockAction(row: any | undefined): 'delist' | 'none' {
  if (row && row['Sync Managed'] === true && row['Active'] === true) return 'delist';
  return 'none';
}

// L11: the loop exits either because the cursor drained (complete) or because
// it hit the page cap with pages remaining (truncated). A non-null cursor at
// the cap means products beyond the cap were NOT synced this run.
export function isCatalogTruncated(cursor: string | null, pages: number, cap: number): boolean {
  return cursor !== null && pages >= cap;
}

// Statuses that mean a Rancher Orders row is finished/reversed — no longer an
// obligation against Shopify's inventory. A 'Refunded' order restores its
// product's Orders Left AND cancels the external push (lib/productSettlement),
// so the unit is back on the shelf everywhere.
const TERMINAL_ORDER_STATUSES = new Set(['Refunded', 'Cancelled', 'Canceled']);

// M4: is this BHC order a unit Shopify's current count still (wrongly) includes?
// TRUE only when the order is live (non-terminal) AND its push to the store
// never succeeded — External Push Status blank ('' — net cron will retry) or
// 'failed:*'. A 'pushed' order already decremented Shopify's count, so counting
// it would double-subtract; 'skipped:*'/'cancelled' never touch Shopify either
// but are deliberately OUT of scope here (spec: blank|failed only).
export function isUnpushedObligation(order: any): boolean {
  const status = String(order?.['Status'] || '').trim();
  if (TERMINAL_ORDER_STATUSES.has(status)) return false;
  const push = String(order?.['External Push Status'] || '').trim().toLowerCase();
  return push === '' || push.startsWith('failed');
}

// M4: total UNITS (summing Quantity, not just row count) of outstanding
// unpushed obligations across a set of Rancher Orders rows.
export function outstandingObligationUnits(orders: any[]): number {
  let units = 0;
  for (const o of orders || []) {
    if (isUnpushedObligation(o)) units += Math.max(1, Number(o['Quantity'] || 1));
  }
  return units;
}

// M4: pull this rancher's outstanding (non-terminal, unpushed) orders ONCE and
// index the obligation UNITS by 'Product Record ID' (the code-proven link —
// productSettlement writes it as the Rancher Products record id; Rancher Orders
// has no External SKU field). One Airtable read per sync, not one per row.
export async function outstandingObligationsByProduct(rancherId: string): Promise<Map<string, number>> {
  const orders = (await getAllRecords(
    TABLES.RANCHER_ORDERS,
    `{Rancher Record ID} = "${escapeAirtableValue(rancherId)}"`,
  ).catch(() => [])) as any[];
  const byProduct = new Map<string, number>();
  for (const o of orders) {
    if (!isUnpushedObligation(o)) continue;
    const pid = String(o['Product Record ID'] || '').trim();
    if (!pid) continue;
    byProduct.set(pid, (byProduct.get(pid) || 0) + Math.max(1, Number(o['Quantity'] || 1)));
  }
  return byProduct;
}

export interface CatalogSyncResult {
  imported: number;
  updated: number;
  skippedNoSku: number;
  skippedGuard: number;
  // H3: sync-managed rows pulled OFF /shop because they now trip the share
  // fence / $5 floor (distinct from `deactivated`, which is SKU-gone-from-store).
  guardDelisted: number;
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
    return { imported: 0, updated: 0, skippedNoSku: 0, skippedGuard: 0, guardDelisted: 0, deactivated: 0, report: ['not in sync mode'] };
  }
  const rancherName = String(rancher['Ranch Name'] || rancher['Operator Name'] || '');

  // Per-rancher concurrency guard (real writes only): a webhook-triggered sync
  // and the scheduled catalog cron can fire for the same rancher near-
  // simultaneously. Both read the same `existing` bySku map, neither sees the
  // other's just-created rows, and each createRecord's the same (rancher, SKU)
  // → duplicate rows on /shop. Serialize with a per-rancher lock (M3).
  //   • claimSyncLock degrades CLOSED on Redis error — a skipped sync is safer
  //     than duplicate rows (the next run reconciles); the money-webhook
  //     claimOnce degrades OPEN, so we deliberately do NOT share it here.
  //   • TTL >= the 300s cron maxDuration so a slow multi-page run can't free
  //     the lock mid-flight; RELEASED in the finally below the instant work
  //     ends, so a follow-up products/update webhook isn't dropped for the TTL.
  // dryRun previews never write, so they don't contend and take no lock.
  const lockKey = `shopify-sync-${rancherId}`;
  let lockAcquired = false;
  if (!opts?.dryRun) {
    const gotLock = await claimSyncLock(lockKey, SYNC_LOCK_TTL_SEC);
    if (!gotLock) {
      return { imported: 0, updated: 0, skippedNoSku: 0, skippedGuard: 0, guardDelisted: 0, deactivated: 0, report: ['skipped — a sync for this rancher is already in progress'] };
    }
    lockAcquired = true;
  }

  try {
    const existing = (await getAllRecords(
      TABLES.RANCHER_PRODUCTS,
      `{Rancher Record ID} = "${escapeAirtableValue(rancherId)}"`,
    )) as any[];
    const bySku = new Map(
      existing
        .filter((r) => String(r['External SKU'] || '').trim())
        .map((r) => [String(r['External SKU']).trim(), r]),
    );

    // M4 oversell guard: BHC orders whose push to the store FAILED (or hasn't
    // run) keep Shopify's inventory count high for a unit that's already sold.
    // Pull this rancher's outstanding obligations ONCE (units keyed by product
    // record id) so an update can subtract them from Shopify's count instead
    // of re-shelving a settlement-decremented unit. dryRun previews don't need
    // it (they only count imported/updated, not field values).
    const obligationByProduct = opts?.dryRun
      ? new Map<string, number>()
      : await outstandingObligationsByProduct(rancherId).catch(() => new Map<string, number>());

    let imported = 0;
    let updated = 0;
    let skippedNoSku = 0;
    let skippedGuard = 0;
    let guardDelisted = 0;
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
        return { imported, updated, skippedNoSku, skippedGuard, guardDelisted, deactivated: 0, report: [`catalog fetch failed on page ${pages + 1} — partial: imported ${imported}, updated ${updated}`] };
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
          if (tripsShareGuard(candidateName, Number(variant.price || 0))) {
            skippedGuard++;
            // H3: a row that WAS live + Sync Managed and now trips the guard
            // (rancher renamed it "Half Beef" or repriced below $5 after it
            // went live) must come OFF /shop — otherwise whole/half/quarter
            // beef sells as a one-click product, defeating the deposit-only
            // share rail. It stays in seenSkus so the reconciliation pass below
            // doesn't also touch it.
            const blockedRow = bySku.get(skuKey);
            if (guardBlockAction(blockedRow) === 'delist') {
              if (!opts?.dryRun) {
                await updateRecord(TABLES.RANCHER_PRODUCTS, blockedRow.id, {
                  'Active': false,
                  'Last Synced At': new Date().toISOString(),
                }).catch(() => {});
              }
              guardDelisted++;
            }
            continue;
          }
          const row = bySku.get(skuKey);
          // M4: for an existing row, drop the units Shopify still lists but
          // BHC already sold (unpushed/failed). A first import has no prior
          // settlement, so its obligation is 0.
          const outstandingObligation = row ? (obligationByProduct.get(String(row.id)) || 0) : 0;
          const fields = mapVariantToProductFields({
            product,
            variant,
            markupPercent: cfg.markupPercent ?? null,
            approved: row?.['Marketplace Approved'] === true,
            outstandingObligation,
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
    } while (cursor && pages < CATALOG_PAGE_CAP); // 40×50 products = plenty; hard stop vs pagination bugs

    const report: string[] = [];

    // L11: the loop can exit with a non-null cursor — it hit the page cap while
    // more pages remained, so products beyond the cap were NOT synced (new
    // listings invisible; stale-row reconciliation skipped). Never silent:
    // report line + a loud operator signal naming the shop.
    if (isCatalogTruncated(cursor, pages, CATALOG_PAGE_CAP)) {
      report.push(`TRUNCATED — hit the ${CATALOG_PAGE_CAP}-page cap (~${pages * 50} products fetched); products beyond ${CATALOG_PAGE_CAP * 50} were NOT synced`);
      if (!opts?.dryRun) {
        try {
          const { sendOperatorSignal } = await import('./operatorSignal');
          await sendOperatorSignal({
            urgency: 'loud',
            kind: 'system-error',
            summary: `Catalog sync TRUNCATED — ${cfg.shop}: >${CATALOG_PAGE_CAP * 50} products, only first ${CATALOG_PAGE_CAP * 50} synced`,
            detail:
              `${rancherName || rancherId} has more than ${CATALOG_PAGE_CAP * 50} SKUs in Shopify. The catalog sync stops at the ${CATALOG_PAGE_CAP}-page cap, ` +
              `so listings beyond ${CATALOG_PAGE_CAP * 50} are not imported/updated and stale-row reconciliation is skipped this run. ` +
              `Raise CATALOG_PAGE_CAP (lib/shopifyCatalogSync) or split the catalog.`,
            refs: [{ type: 'rancher', id: rancherId, label: rancherName }],
            dedupeKey: `shopify-catalog-truncated-${rancherId}`,
            dedupeWindowMs: 6 * 60 * 60 * 1000, // once per sync cadence
          });
        } catch (e: any) {
          console.error('[shopifyCatalogSync] truncation signal failed:', e?.message);
        }
      }
    }

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

    report.push(
      `${opts?.dryRun ? '[dry-run] ' : ''}imported ${imported}, updated ${updated}, no-SKU skipped ${skippedNoSku}` +
        (skippedGuard ? `, guard-blocked ${skippedGuard} (share-fence/$5 floor)` : '') +
        (guardDelisted ? `, delisted ${guardDelisted} (now trips share-fence/$5 floor)` : '') +
        (deactivated ? `, pulled ${deactivated} (SKU gone from store)` : ''),
    );

    return { imported, updated, skippedNoSku, skippedGuard, guardDelisted, deactivated, report };
  } finally {
    // Free the lock the instant the work ends (M3) — the TTL is only a
    // crash backstop. releaseClaim swallows its own errors; the extra catch is
    // belt-and-suspenders so a release failure can never mask the real result.
    if (lockAcquired) await releaseClaim(lockKey).catch(() => {});
  }
}
