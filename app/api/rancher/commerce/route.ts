// app/api/rancher/commerce/route.ts — authenticated rancher CRUD over the
// commerce catalog (products / variants / inventory). Phase-1C dashboard editor.
//
// SECURITY MODEL (read before touching):
//   - The rancher_id is ALWAYS taken from the verified session, NEVER from the
//     request body. Any client-supplied rancher_id is ignored.
//   - Variants and inventory are addressed by id (variant_id / product_id),
//     which a malicious client could forge to point at ANOTHER rancher's rows.
//     So before any variant/inventory mutation we load THIS rancher's products
//     (getRancherProducts is already rancher-scoped) and reject the op unless
//     the target product/variant id is in that owned set. Ownership is proven
//     against the session, not asserted by the caller.
//   - Money crosses the wire as DOLLARS (matching the rest of the dashboard's
//     number inputs) and is converted to integer CENTS + validated server-side.
//     Price floor + deposit derivation come from lib/pricing (single source of
//     truth) — nothing is hardcoded here.
//
// BUILD-DARK: every repository fn null-checks getCommerceDb(). When the commerce
// DB isn't provisioned, `list` returns [] (dashboard shows the calm placeholder)
// and mutations would throw the repo's "commerce DB not configured" error, which
// we surface as a 503 so the UI can explain instead of 500-ing.

import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireRancher } from '@/lib/rancherAuth';
import {
  getRancherProducts,
  upsertProduct,
  upsertVariant,
  deleteVariant,
  deleteProduct,
  setInventory,
  getOpenOrdersForVariant,
  type ProductWithVariants,
} from '@/lib/commerce/repository';
import { getCommerceDb } from '@/lib/commerce/client';
import type { ProductStatus, ProductType } from '@/lib/commerce/types';
import { deriveDeposit, isTierPricePlausible, MIN_TIER_PRICE } from '@/lib/pricing';
import { getRecordById, TABLES } from '@/lib/airtable';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Dollars (number | numeric string) → integer cents. null when not parseable. */
function dollarsToCents(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Integer cents → whole dollars (for feeding lib/pricing, which works in $). */
function centsToDollars(cents: number): number {
  return cents / 100;
}

function slugify(s: string): string {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Map the repo's "not configured" throw to a 503 the UI can explain. */
function isUnconfigured(err: unknown): boolean {
  return err instanceof Error && /not configured/i.test(err.message);
}

/**
 * Bust the ISR cache for this rancher's PUBLIC ranch page after a catalog
 * mutation. The buyer page (/ranchers/[slug]) is ISR with revalidate=600, so
 * without this a price/inventory edit can lag up to 10 min behind the dashboard.
 *
 * The slug is resolved SERVER-SIDE from the session's rancherId via the Airtable
 * record (never trusted from the request body). Best-effort: a slug miss or a
 * revalidate error must NOT fail the mutation that already succeeded, so we
 * swallow + log. Skip entirely on read ('list').
 */
async function revalidateRanchPage(rancherId: string): Promise<void> {
  try {
    const rec: any = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
    const slug = rec && typeof rec['Slug'] === 'string' ? rec['Slug'].trim() : '';
    if (!slug) return; // No public page yet (unpublished rancher) — nothing to bust.
    revalidatePath('/ranchers/' + slug);
  } catch (err: any) {
    // Non-fatal: the write landed; the page will self-heal on its next revalidate window.
    console.error('[rancher/commerce] revalidate failed:', err?.message || err);
  }
}

// Flatten the owned products into quick membership lookups so every
// variant/inventory mutation can be authorized against the session rancher.
interface OwnedIndex {
  products: ProductWithVariants[];
  productIds: Set<string>;
  variantToProduct: Map<string, string>; // variant_id → product_id
}

function indexOwned(products: ProductWithVariants[]): OwnedIndex {
  const productIds = new Set<string>();
  const variantToProduct = new Map<string, string>();
  for (const p of products) {
    productIds.add(p.id);
    for (const v of p.variants) variantToProduct.set(v.id, p.id);
  }
  return { products, productIds, variantToProduct };
}

// ── Route ──────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const r = await requireRancher(request);
  if (r instanceof NextResponse) return r;
  const rancherId = r.session.rancherId;

  let body: Record<string, any>;
  try {
    body = await request.json();
  } catch {
    return bad('Invalid JSON body.');
  }

  const action = String(body.action || '');

  try {
    switch (action) {
      // ── list ────────────────────────────────────────────────────────────
      // All statuses for management. Empty array on unconfigured DB (build-dark)
      // OR a rancher with no commerce catalog yet — the UI treats both the same.
      case 'list': {
        const products = await getRancherProducts(rancherId);
        return NextResponse.json({ products });
      }

      // ── upsert-product ─────────────────────────────────────────────────────
      // Create/update a product shell. rancher_id is forced to the session.
      // Slug is server-derived from the name when absent (kept stable on edit
      // by passing the existing slug). type defaults to 'custom' (the only kind
      // a rancher creates by hand; cow_share products come from the ETL).
      case 'upsert-product': {
        const name = String(body.name || '').trim();
        if (!name) return bad('Product name is required.');

        // If editing, the product must already belong to this rancher.
        const owned = indexOwned(await getRancherProducts(rancherId));
        const id = body.id ? String(body.id) : undefined;
        if (id && !owned.productIds.has(id)) {
          return bad('That product is not in your catalog.', 403);
        }

        const type: ProductType = body.type === 'cow_share' || body.type === 'csa'
          ? body.type
          : 'custom';
        const status: ProductStatus =
          body.status === 'active' || body.status === 'archived' || body.status === 'draft'
            ? body.status
            : 'active';

        // Prefer an explicit slug; else reuse the existing product's slug on
        // edit; else derive from the name. Never collides across ranchers — the
        // products unique key is (rancher_id, slug), scoped per tenant.
        const existing = id ? owned.products.find((p) => p.id === id) : undefined;
        const slug =
          slugify(String(body.slug || '')) ||
          existing?.slug ||
          slugify(name) ||
          `product-${Date.now()}`;

        const product = await upsertProduct({
          ...(id ? { id } : {}),
          rancher_id: rancherId, // SERVER-SIDE — client value (if any) ignored.
          slug,
          type,
          name,
          description:
            body.description === undefined ? undefined : (String(body.description).trim() || null),
          status,
          ...(body.position !== undefined ? { position: Number(body.position) || 0 } : {}),
        });

        // Convenience: let the editor create a product + its single variant in
        // one round-trip when a price is supplied (custom products are 1-variant).
        let variant = null;
        if (body.price_dollars !== undefined && body.price_dollars !== '' && body.price_dollars !== null) {
          const v = await upsertSingleVariantForProduct(product.id, {
            existingVariantId: existing?.variants[0]?.id,
            label: String(body.variant_label || name).trim() || name,
            priceDollars: body.price_dollars,
            depositDollars: body.deposit_dollars,
            weightLbs: body.weight_lbs,
          });
          if ('error' in v) return bad(v.error, v.status);
          variant = v.variant;

          // Optional inventory in the same call: blank/undefined = unlimited
          // (leave no inventory row), a number = finite stock.
          if (body.qty_available !== undefined && String(body.qty_available).trim() !== '') {
            const qty = Math.floor(Number(body.qty_available));
            if (!Number.isFinite(qty) || qty < 0) return bad('Stock must be 0 or a positive whole number.');
            await setInventory(variant.id, qty);
          }
        }

        await revalidateRanchPage(rancherId);
        return NextResponse.json({ product, variant });
      }

      // ── upsert-variant ─────────────────────────────────────────────────────
      // Add/edit a single variant. The PARENT product must belong to this
      // rancher; on edit the variant id must also resolve to an owned product.
      case 'upsert-variant': {
        const productId = String(body.product_id || '');
        if (!productId) return bad('product_id is required.');

        const owned = indexOwned(await getRancherProducts(rancherId));
        if (!owned.productIds.has(productId)) {
          return bad('That product is not in your catalog.', 403);
        }
        const variantId = body.id ? String(body.id) : undefined;
        if (variantId && owned.variantToProduct.get(variantId) !== productId) {
          return bad('That variant is not in your catalog.', 403);
        }

        const v = await upsertSingleVariantForProduct(productId, {
          existingVariantId: variantId,
          label: String(body.label || '').trim(),
          priceDollars: body.price_dollars,
          depositDollars: body.deposit_dollars,
          weightLbs: body.weight_lbs,
          position: body.position,
        });
        if ('error' in v) return bad(v.error, v.status);
        await revalidateRanchPage(rancherId);
        return NextResponse.json({ variant: v.variant });
      }

      // ── set-inventory ──────────────────────────────────────────────────────
      // Finite stock = a non-negative integer. The caller clears stock back to
      // "unlimited" via clear-inventory (delete the row) — setInventory only
      // ever sets a finite number.
      case 'set-inventory': {
        const variantId = String(body.variant_id || '');
        if (!variantId) return bad('variant_id is required.');
        const owned = indexOwned(await getRancherProducts(rancherId));
        if (!owned.variantToProduct.has(variantId)) {
          return bad('That variant is not in your catalog.', 403);
        }
        const qty = Math.floor(Number(body.qty_available));
        if (!Number.isFinite(qty) || qty < 0) {
          return bad('Stock must be 0 or a positive whole number.');
        }
        await setInventory(variantId, qty);
        await revalidateRanchPage(rancherId);
        return NextResponse.json({ success: true, variant_id: variantId, qty_available: qty });
      }

      // ── clear-inventory ────────────────────────────────────────────────────
      // Delete the inventory row → the variant reverts to UNLIMITED stock
      // (a variant with no inventory record is unlimited; see migration 0001).
      // The repository only exposes setInventory (finite stock), so the row
      // delete is done here via the commerce client, still rancher-scoped by
      // the owned-variant guard. Idempotent: clearing an already-unlimited
      // variant is a no-op success.
      case 'clear-inventory': {
        const variantId = String(body.variant_id || '');
        if (!variantId) return bad('variant_id is required.');
        const owned = indexOwned(await getRancherProducts(rancherId));
        if (!owned.variantToProduct.has(variantId)) {
          return bad('That variant is not in your catalog.', 403);
        }
        const db = getCommerceDb();
        if (!db) {
          return NextResponse.json(
            { error: 'Catalog tools are not switched on yet.' },
            { status: 503 },
          );
        }
        const { error } = await db.from('inventory').delete().eq('variant_id', variantId);
        if (error) throw new Error(`clear-inventory: ${error.message}`);
        await revalidateRanchPage(rancherId);
        return NextResponse.json({ success: true, variant_id: variantId, qty_available: null });
      }

      // ── delete-variant ─────────────────────────────────────────────────────
      // FK guard: order_line_items.variant_id is ON DELETE RESTRICT (migration
      // 0002). Deleting a variant that any non-cancelled order references would
      // either error at the DB or (pre-migration) null the line so the webhook's
      // consume loop skips it → oversell after delete+recreate. Refuse with a 409
      // and steer the rancher to ARCHIVE instead (status:'archived' via upsert).
      case 'delete-variant': {
        const variantId = String(body.variant_id || body.id || '');
        if (!variantId) return bad('variant_id is required.');
        const owned = indexOwned(await getRancherProducts(rancherId));
        if (!owned.variantToProduct.has(variantId)) {
          return bad('That variant is not in your catalog.', 403);
        }
        const openOrders = await getOpenOrdersForVariant(variantId);
        if (openOrders.length > 0) {
          return NextResponse.json(
            {
              error: 'This product has orders — archive it instead of deleting.',
              suggestion: 'archive',
              order_count: openOrders.length,
            },
            { status: 409 },
          );
        }
        await deleteVariant(variantId);
        await revalidateRanchPage(rancherId);
        return NextResponse.json({ success: true });
      }

      // ── delete-product ─────────────────────────────────────────────────────
      // Hard delete. (Archiving is done via upsert-product status:'archived'.)
      // FK guard: deleting a product CASCADES to its variants (migration 0001),
      // and each variant is ON DELETE RESTRICT against order_line_items
      // (migration 0002). So before deleting we check EVERY owned variant of this
      // product for non-cancelled orders and refuse the whole delete if any has
      // them — steering the rancher to archive instead. (Archiving the product
      // hides every variant from buyers without touching the order history.)
      case 'delete-product': {
        const productId = String(body.product_id || body.id || '');
        if (!productId) return bad('product_id is required.');
        const owned = indexOwned(await getRancherProducts(rancherId));
        if (!owned.productIds.has(productId)) {
          return bad('That product is not in your catalog.', 403);
        }
        const product = owned.products.find((p) => p.id === productId);
        const variantIds = product ? product.variants.map((v) => v.id) : [];
        const orderIds = new Set<string>();
        for (const vid of variantIds) {
          for (const oid of await getOpenOrdersForVariant(vid)) orderIds.add(oid);
        }
        if (orderIds.size > 0) {
          return NextResponse.json(
            {
              error: 'This product has orders — archive it instead of deleting.',
              suggestion: 'archive',
              order_count: orderIds.size,
            },
            { status: 409 },
          );
        }
        await deleteProduct(productId);
        await revalidateRanchPage(rancherId);
        return NextResponse.json({ success: true });
      }

      default:
        return bad(`Unknown action "${action}".`);
    }
  } catch (err: any) {
    if (isUnconfigured(err)) {
      // Build-dark: DB not provisioned. The UI shows the rollout placeholder.
      return NextResponse.json(
        { error: 'Catalog tools are not switched on yet.' },
        { status: 503 },
      );
    }
    console.error('[rancher/commerce] error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to save catalog changes.' }, { status: 500 });
  }
}

// ── Variant write (shared by upsert-product convenience + upsert-variant) ─────
//
// Centralizes the money math + validation so the price floor and deposit
// derivation are applied identically everywhere:
//   - price_cents ≥ MIN_TIER_PRICE*100 (via isTierPricePlausible on dollars),
//     unless exactly 0 (a deliberately free/placeholder line).
//   - deposit: when omitted, derived from the price via lib/pricing
//     (deriveDeposit, in dollars). Always validated 0 < deposit ≤ price.
type VariantWriteResult =
  | { variant: Awaited<ReturnType<typeof upsertVariant>> }
  | { error: string; status: number };

async function upsertSingleVariantForProduct(
  productId: string,
  opts: {
    existingVariantId?: string;
    label: string;
    priceDollars: unknown;
    depositDollars?: unknown;
    weightLbs?: unknown;
    position?: unknown;
  },
): Promise<VariantWriteResult> {
  const label = opts.label.trim();
  if (!label) return { error: 'Variant label is required.', status: 400 };

  const priceCents = dollarsToCents(opts.priceDollars);
  if (priceCents === null || priceCents < 0) {
    return { error: 'Enter a valid price.', status: 400 };
  }
  // Per-lb mis-entry floor, reusing lib/pricing's tier-price guard (dollars).
  // 0 is allowed (free line); any positive value must clear MIN_TIER_PRICE.
  const priceDollars = centsToDollars(priceCents);
  if (!isTierPricePlausible(priceDollars)) {
    return {
      error: `Price looks too low — a real share is at least $${MIN_TIER_PRICE}. ` +
        `If you meant a per-pound number, enter the full price instead.`,
      status: 400,
    };
  }

  // Deposit: explicit (dollars) when provided, else derived from the price.
  let depositCents: number;
  const explicitDeposit = dollarsToCents(opts.depositDollars);
  if (explicitDeposit !== null) {
    depositCents = explicitDeposit;
  } else {
    // deriveDeposit works in whole dollars and floors/caps sensibly.
    depositCents = Math.round(deriveDeposit(priceDollars) * 100);
  }

  // A 0-priced line carries a 0 deposit (nothing to reserve). Any priced line
  // must have 0 < deposit ≤ price so the buyer never pays 100% upfront and the
  // deposit is never negative/zero on a real product.
  if (priceCents === 0) {
    depositCents = 0;
  } else if (depositCents <= 0 || depositCents > priceCents) {
    return {
      error: `Deposit must be greater than $0 and no more than the price ($${priceDollars}).`,
      status: 400,
    };
  }

  const weightLbs =
    opts.weightLbs === undefined || opts.weightLbs === '' || opts.weightLbs === null
      ? null
      : Number(opts.weightLbs);
  if (weightLbs !== null && (!Number.isFinite(weightLbs) || weightLbs < 0)) {
    return { error: 'Weight must be a positive number of pounds.', status: 400 };
  }

  const variant = await upsertVariant({
    ...(opts.existingVariantId ? { id: opts.existingVariantId } : {}),
    product_id: productId,
    label,
    price_cents: priceCents,
    deposit_cents: depositCents,
    weight_lbs: weightLbs,
    ...(opts.position !== undefined ? { position: Number(opts.position) || 0 } : {}),
  });
  return { variant };
}
