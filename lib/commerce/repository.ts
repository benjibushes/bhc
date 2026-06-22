// lib/commerce/repository.ts — the data-access layer for the commerce system
// (Supabase). THE shared contract Phase-1 surfaces build on: the buyer ranch
// page reads the catalog, the cart/checkout resolves variants + reserves stock,
// the dashboard editor mutates products/variants/inventory.
//
// BUILD-DARK: every function checks getCommerceDb(). When the commerce DB isn't
// configured (no SUPABASE env), reads return empty + mutations throw a clear
// error, so callers MUST fall back to the legacy Airtable path on empty reads.
// This keeps prod untouched until the env is flipped on.
//
// Tenant isolation: all access is server-side via the service-role key; every
// query is scoped by rancher_id. Money in integer cents.

import { getCommerceDb } from './client';
import type {
  Product,
  ProductVariant,
  Order,
  OrderStatus,
  OrderLineItem,
  ProductType,
  ProductStatus,
} from './types';

export interface VariantWithAvailability extends ProductVariant {
  /** Units available to sell (qty_available − qty_reserved), or null = unlimited (no inventory row). */
  available: number | null;
}

export interface ProductWithVariants extends Product {
  variants: VariantWithAvailability[];
}

// ── Catalog reads ────────────────────────────────────────────────────────────

/**
 * Buyer-facing catalog for a ranch page: ACTIVE products + their variants +
 * availability, ordered for display. Empty array when commerce DB unconfigured
 * OR the rancher has no commerce products yet (caller falls back to the legacy
 * Airtable cow-share columns).
 */
export async function getRancherCatalog(rancherId: string): Promise<ProductWithVariants[]> {
  return loadProducts(rancherId, { statuses: ['active'] });
}

/** Dashboard view: ALL products (every status) for the rancher to manage. */
export async function getRancherProducts(rancherId: string): Promise<ProductWithVariants[]> {
  return loadProducts(rancherId, { statuses: ['draft', 'active', 'archived'] });
}

async function loadProducts(
  rancherId: string,
  opts: { statuses: ProductStatus[] },
): Promise<ProductWithVariants[]> {
  const db = getCommerceDb();
  if (!db || !rancherId) return [];

  const { data: products, error: pErr } = await db
    .from('products')
    .select('*')
    .eq('rancher_id', rancherId)
    .in('status', opts.statuses)
    .order('position', { ascending: true });
  if (pErr) throw new Error(`getRancherCatalog products: ${pErr.message}`);
  if (!products || products.length === 0) return [];

  const productIds = products.map((p: Product) => p.id);
  const { data: variants, error: vErr } = await db
    .from('product_variants')
    .select('*')
    .in('product_id', productIds)
    .order('position', { ascending: true });
  if (vErr) throw new Error(`getRancherCatalog variants: ${vErr.message}`);

  const variantIds = (variants || []).map((v: ProductVariant) => v.id);
  const availability = await getAvailability(variantIds);

  const byProduct = new Map<string, VariantWithAvailability[]>();
  for (const v of (variants || []) as ProductVariant[]) {
    const list = byProduct.get(v.product_id) || [];
    list.push({ ...v, available: availability.get(v.id) ?? null });
    byProduct.set(v.product_id, list);
  }
  return (products as Product[]).map((p) => ({ ...p, variants: byProduct.get(p.id) || [] }));
}

/** Resolve specific variants by id (cart/checkout). Returns [] when unconfigured. */
export async function getVariantsByIds(ids: string[]): Promise<ProductVariant[]> {
  const db = getCommerceDb();
  if (!db || ids.length === 0) return [];
  const { data, error } = await db.from('product_variants').select('*').in('id', ids);
  if (error) throw new Error(`getVariantsByIds: ${error.message}`);
  return (data || []) as ProductVariant[];
}

/** A single variant joined to its product (for cart line resolution + rancher scoping). */
export async function getVariantWithProduct(
  variantId: string,
): Promise<{ variant: ProductVariant; product: Product } | null> {
  const db = getCommerceDb();
  if (!db) return null;
  const { data, error } = await db
    .from('product_variants')
    .select('*, products(*)')
    .eq('id', variantId)
    .maybeSingle();
  if (error) throw new Error(`getVariantWithProduct: ${error.message}`);
  if (!data) return null;
  const { products, ...variant } = data as any;
  return { variant: variant as ProductVariant, product: products as Product };
}

// ── Inventory (transactional — calls the Postgres functions) ─────────────────

/**
 * Availability per variant. Returns a map of variantId → available units, where
 * a variant with NO inventory row maps to null (= unlimited stock). Variants
 * absent from the map (unconfigured DB / no ids) should be treated as unlimited.
 */
export async function getAvailability(variantIds: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const db = getCommerceDb();
  if (!db || variantIds.length === 0) return out;
  const { data, error } = await db
    .from('inventory')
    .select('variant_id, qty_available, qty_reserved')
    .in('variant_id', variantIds);
  if (error) throw new Error(`getAvailability: ${error.message}`);
  for (const row of (data || []) as { variant_id: string; qty_available: number; qty_reserved: number }[]) {
    out.set(row.variant_id, Math.max(0, row.qty_available - row.qty_reserved));
  }
  // variantIds not present have no inventory row → unlimited (null).
  for (const id of variantIds) if (!out.has(id)) out.set(id, null);
  return out;
}

/**
 * Atomically reserve stock for a variant. Returns true on success, false if
 * insufficient. A variant with no inventory row is unlimited → always true.
 * Throws if the commerce DB isn't configured (never silently "succeed").
 */
export async function reserveInventory(variantId: string, qty: number): Promise<boolean> {
  const db = getCommerceDb();
  if (!db) throw new Error('reserveInventory: commerce DB not configured');
  const { data, error } = await db.rpc('reserve_inventory', { p_variant_id: variantId, p_qty: qty });
  if (error) throw new Error(`reserveInventory: ${error.message}`);
  return data === true;
}

/** Release a prior reservation; pass consume=true to also lower qty_available (sale confirmed). */
export async function releaseInventory(variantId: string, qty: number, consume = false): Promise<void> {
  const db = getCommerceDb();
  if (!db) throw new Error('releaseInventory: commerce DB not configured');
  const { error } = await db.rpc('release_inventory', {
    p_variant_id: variantId,
    p_qty: qty,
    p_consume: consume,
  });
  if (error) throw new Error(`releaseInventory: ${error.message}`);
}

/**
 * RESTOCK — raise qty_available by qty (returns refunded/cancelled units to
 * sellable stock). No-op when no inventory row exists (unlimited variant).
 * Distinct from releaseInventory(consume=false), which only lowers qty_reserved.
 * Calls the restock_inventory Postgres fn (migration 0003).
 */
export async function restockInventory(variantId: string, qty: number): Promise<void> {
  const db = getCommerceDb();
  if (!db) throw new Error('restockInventory: commerce DB not configured');
  const { error } = await db.rpc('restock_inventory', { p_variant_id: variantId, p_qty: qty });
  if (error) throw new Error(`restockInventory: ${error.message}`);
}

/** Orders for a buyer (newest first) with their line items — buyer order history. */
export async function getOrdersByBuyer(buyerId: string): Promise<(Order & { order_line_items: OrderLineItem[] })[]> {
  const db = getCommerceDb();
  if (!db || !buyerId) return [];
  const { data, error } = await db
    .from('orders')
    .select('*, order_line_items(*)')
    .eq('buyer_id', buyerId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`getOrdersByBuyer: ${error.message}`);
  return (data || []) as (Order & { order_line_items: OrderLineItem[] })[];
}

/**
 * Orders for a rancher's dashboard (newest first) with line items. Optionally
 * filter by status (e.g. ['paid'] for fulfillment / balance collection).
 */
export async function getOrdersForRancher(
  rancherId: string,
  opts?: { statuses?: OrderStatus[] },
): Promise<(Order & { order_line_items: OrderLineItem[] })[]> {
  const db = getCommerceDb();
  if (!db || !rancherId) return [];
  let q = db.from('orders').select('*, order_line_items(*)').eq('rancher_id', rancherId);
  if (opts?.statuses && opts.statuses.length) q = q.in('status', opts.statuses);
  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) throw new Error(`getOrdersForRancher: ${error.message}`);
  return (data || []) as (Order & { order_line_items: OrderLineItem[] })[];
}

/** Set absolute stock for a variant (dashboard). Upserts the inventory row. */
export async function setInventory(variantId: string, qtyAvailable: number): Promise<void> {
  const db = getCommerceDb();
  if (!db) throw new Error('setInventory: commerce DB not configured');
  const { error } = await db
    .from('inventory')
    .upsert({ variant_id: variantId, qty_available: Math.max(0, Math.floor(qtyAvailable)), updated_at: new Date().toISOString() }, { onConflict: 'variant_id' });
  if (error) throw new Error(`setInventory: ${error.message}`);
}

// ── Orders ───────────────────────────────────────────────────────────────────

export interface NewOrderLine {
  variant_id: string | null;
  label: string;
  qty: number;
  unit_price_cents: number;
  fee_cents: number;
}

export interface NewOrder {
  rancher_id: string;
  buyer_id?: string | null;
  referral_id?: string | null;
  status?: OrderStatus;
  subtotal_cents: number;
  fee_cents: number;
  deposit_cents: number;
  stripe_checkout_session_id?: string | null;
  stripe_payment_intent_id?: string | null;
  lines: NewOrderLine[];
}

/** Create an order + its line items. Returns the order. Throws when unconfigured. */
export async function createOrder(input: NewOrder): Promise<Order> {
  const db = getCommerceDb();
  if (!db) throw new Error('createOrder: commerce DB not configured');
  const { data: order, error: oErr } = await db
    .from('orders')
    .insert({
      rancher_id: input.rancher_id,
      buyer_id: input.buyer_id ?? null,
      referral_id: input.referral_id ?? null,
      status: input.status ?? 'pending',
      subtotal_cents: input.subtotal_cents,
      fee_cents: input.fee_cents,
      deposit_cents: input.deposit_cents,
      stripe_checkout_session_id: input.stripe_checkout_session_id ?? null,
      stripe_payment_intent_id: input.stripe_payment_intent_id ?? null,
    })
    .select('*')
    .single();
  if (oErr) throw new Error(`createOrder: ${oErr.message}`);
  if (input.lines.length > 0) {
    const { error: lErr } = await db.from('order_line_items').insert(
      input.lines.map((l) => ({ order_id: (order as Order).id, ...l })),
    );
    if (lErr) throw new Error(`createOrder lines: ${lErr.message}`);
  }
  return order as Order;
}

export async function getOrder(id: string): Promise<Order | null> {
  const db = getCommerceDb();
  if (!db) return null;
  const { data, error } = await db.from('orders').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`getOrder: ${error.message}`);
  return (data as Order) || null;
}

export async function getOrderByCheckoutSession(sessionId: string): Promise<Order | null> {
  const db = getCommerceDb();
  if (!db) return null;
  const { data, error } = await db
    .from('orders')
    .select('*')
    .eq('stripe_checkout_session_id', sessionId)
    .maybeSingle();
  if (error) throw new Error(`getOrderByCheckoutSession: ${error.message}`);
  return (data as Order) || null;
}

/** Find a commerce order by its Stripe PaymentIntent id (PI-based webhook fallback + refunds). */
export async function getOrderByPaymentIntent(paymentIntentId: string): Promise<Order | null> {
  const db = getCommerceDb();
  if (!db || !paymentIntentId) return null;
  const { data, error } = await db
    .from('orders')
    .select('*')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .maybeSingle();
  if (error) throw new Error(`getOrderByPaymentIntent: ${error.message}`);
  return (data as Order) || null;
}

/**
 * Orders that still hold/own a given variant — i.e. NOT in a terminal cancelled
 * state. Used to refuse deleting a variant that an open or paid order references
 * (protects the consume path + audit trail). Returns the order ids.
 */
export async function getOpenOrdersForVariant(variantId: string): Promise<string[]> {
  const db = getCommerceDb();
  if (!db || !variantId) return [];
  const { data, error } = await db
    .from('order_line_items')
    .select('order_id, orders!inner(status)')
    .eq('variant_id', variantId)
    .neq('orders.status', 'cancelled');
  if (error) throw new Error(`getOpenOrdersForVariant: ${error.message}`);
  return Array.from(new Set((data || []).map((r: any) => r.order_id as string)));
}

export async function getOrderLines(orderId: string): Promise<OrderLineItem[]> {
  const db = getCommerceDb();
  if (!db) return [];
  const { data, error } = await db.from('order_line_items').select('*').eq('order_id', orderId);
  if (error) throw new Error(`getOrderLines: ${error.message}`);
  return (data || []) as OrderLineItem[];
}

export async function updateOrder(
  id: string,
  fields: Partial<Pick<Order, 'status' | 'stripe_payment_intent_id' | 'stripe_checkout_session_id'>>,
): Promise<void> {
  const db = getCommerceDb();
  if (!db) throw new Error('updateOrder: commerce DB not configured');
  const { error } = await db
    .from('orders')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`updateOrder: ${error.message}`);
}

// ── Catalog mutations (dashboard editor) ─────────────────────────────────────

export interface UpsertProductInput {
  id?: string;
  rancher_id: string;
  slug: string;
  type: ProductType;
  name: string;
  description?: string | null;
  status?: ProductStatus;
  position?: number;
}

export async function upsertProduct(input: UpsertProductInput): Promise<Product> {
  const db = getCommerceDb();
  if (!db) throw new Error('upsertProduct: commerce DB not configured');
  const row = {
    ...(input.id ? { id: input.id } : {}),
    rancher_id: input.rancher_id,
    slug: input.slug,
    type: input.type,
    name: input.name,
    description: input.description ?? null,
    status: input.status ?? 'draft',
    position: input.position ?? 0,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from('products')
    .upsert(row, { onConflict: 'rancher_id,slug' })
    .select('*')
    .single();
  if (error) throw new Error(`upsertProduct: ${error.message}`);
  return data as Product;
}

export interface UpsertVariantInput {
  id?: string;
  product_id: string;
  label: string;
  price_cents: number;
  deposit_cents: number;
  weight_lbs?: number | null;
  stripe_price_id?: string | null;
  tax_code?: string | null;
  position?: number;
}

export async function upsertVariant(input: UpsertVariantInput): Promise<ProductVariant> {
  const db = getCommerceDb();
  if (!db) throw new Error('upsertVariant: commerce DB not configured');
  const { data, error } = await db
    .from('product_variants')
    .upsert({ ...input, updated_at: new Date().toISOString() })
    .select('*')
    .single();
  if (error) throw new Error(`upsertVariant: ${error.message}`);
  return data as ProductVariant;
}

export async function deleteVariant(variantId: string): Promise<void> {
  const db = getCommerceDb();
  if (!db) throw new Error('deleteVariant: commerce DB not configured');
  const { error } = await db.from('product_variants').delete().eq('id', variantId);
  if (error) throw new Error(`deleteVariant: ${error.message}`);
}

export async function deleteProduct(productId: string): Promise<void> {
  const db = getCommerceDb();
  if (!db) throw new Error('deleteProduct: commerce DB not configured');
  const { error } = await db.from('products').delete().eq('id', productId);
  if (error) throw new Error(`deleteProduct: ${error.message}`);
}
