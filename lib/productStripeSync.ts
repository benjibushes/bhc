// lib/productStripeSync.ts
//
// PRODUCTS IN STRIPE (2026-07-06, founder: "all products made in Stripe").
// Each low-ticket catalog row (Rancher Products) becomes a real Stripe Product
// + Price — created ON THE RANCHER'S CONNECTED ACCOUNT (Stripe-Account header),
// NOT the platform account. The rail is a direct charge, so a platform-scoped
// Price is invisible to the connected-account Checkout Session ("No such
// price"). Confirmed by Stripe direct-charge docs (audit 2026-07-06).
//
// Model (Stripe Prices are IMMUTABLE):
//   - ONE Product per catalog row, created once + reused (name is mutable).
//   - a NEW Price whenever Display Price changes; the old Price is archived
//     (active:false). Idempotency-Keys make retries/double-clicks safe.
//   - the reuse guard is 'Stripe Price Cents': if it already equals the
//     current Display Price cents, reuse the stored Price id — no Stripe call.
//
// Called LAZILY from the checkout route (mint-on-first-sell) so we never touch
// Stripe for a product nobody buys.

import { getStripeClient } from '@/lib/stripeConnect';
import { isDemoMode } from '@/lib/demo/demoMode';

export interface PriceReuseInput {
  existingProductId?: string;
  existingPriceId?: string;
  existingPriceCents?: number;
  displayCents: number;
}

export interface PriceReuseDecision {
  /** Reuse the stored Price id as-is (no Stripe call needed). */
  reusePrice: boolean;
  /** Reuse the stored Product id (only mint a new Price under it). */
  reuseProduct: boolean;
}

/**
 * Pure decision: given what's stored on the row + the current display price,
 * decide whether we can reuse the existing Stripe Price, or must mint a new
 * Price (and whether we can reuse the existing Product to hang it under).
 */
export function resolvePriceAction(input: PriceReuseInput): PriceReuseDecision {
  const display = Math.round(Number(input.displayCents));
  const stored = Math.round(Number(input.existingPriceCents ?? -1));
  const hasProduct = !!String(input.existingProductId || '').trim();
  const hasPrice = !!String(input.existingPriceId || '').trim();
  const reusePrice = hasProduct && hasPrice && Number.isFinite(display) && display > 0 && stored === display;
  return { reusePrice, reuseProduct: hasProduct };
}

export interface EnsureStripePriceInput {
  productRecordId: string;     // Airtable Rancher Products record id (idempotency anchor)
  productName: string;
  displayCents: number;
  connectAccountId: string;    // acct_* — the connected account to create on
  existingProductId?: string;
  existingPriceId?: string;
  existingPriceCents?: number;
}

export interface EnsureStripePriceResult {
  productId: string;
  priceId: string;
  priceCents: number;
  /** true when a new Product and/or Price was created this call (caller should stamp Airtable). */
  changed: boolean;
}

/**
 * Ensure a live Stripe Product + Price exists on the connected account for this
 * catalog row, matching the current Display Price. Returns the ids to stamp back
 * to Airtable + a `changed` flag (false when nothing was minted — a pure reuse).
 * Idempotent via resolvePriceAction + Stripe Idempotency-Keys.
 */
export async function ensureStripePrice(input: EnsureStripePriceInput): Promise<EnsureStripePriceResult> {
  const displayCents = Math.round(Number(input.displayCents));
  if (!Number.isFinite(displayCents) || displayCents <= 0) {
    throw new Error(`ensureStripePrice: invalid displayCents ${input.displayCents}`);
  }
  if (!input.connectAccountId) {
    throw new Error('ensureStripePrice: missing connectAccountId');
  }

  const decision = resolvePriceAction({
    existingProductId: input.existingProductId,
    existingPriceId: input.existingPriceId,
    existingPriceCents: input.existingPriceCents,
    displayCents,
  });

  // Nothing changed — reuse the stored Price. No Stripe call.
  if (decision.reusePrice) {
    return {
      productId: String(input.existingProductId),
      priceId: String(input.existingPriceId),
      priceCents: displayCents,
      changed: false,
    };
  }

  // DEMO MODE (local only) — never true in prod. Return synthetic ids.
  if (isDemoMode()) {
    return { productId: 'prod_DEMO', priceId: 'price_DEMO', priceCents: displayCents, changed: true };
  }

  const stripe = getStripeClient();
  const opts = { stripeAccount: input.connectAccountId };

  // 1) Product — reuse if we have one, else create (idempotency-keyed on the
  //    Airtable record id so a retry/double-click never mints duplicates).
  let productId = String(input.existingProductId || '').trim();
  if (!productId) {
    const product = await stripe.products.create(
      { name: input.productName || 'BuyHalfCow product', metadata: { productRecordId: input.productRecordId } },
      { ...opts, idempotencyKey: `prod:${input.productRecordId}` },
    );
    productId = product.id;
  }

  // 2) Price — always a NEW immutable Price at the current cents (idempotency
  //    key includes the cents so re-running at the same price is a no-op create).
  const price = await stripe.prices.create(
    { product: productId, currency: 'usd', unit_amount: displayCents, metadata: { productRecordId: input.productRecordId } },
    { ...opts, idempotencyKey: `price:${input.productRecordId}:${displayCents}` },
  );

  // 3) Archive the prior Price (best-effort — a stale active Price is harmless
  //    but tidy is better). Never throw the whole sync on an archive blip.
  const oldPriceId = String(input.existingPriceId || '').trim();
  if (oldPriceId && oldPriceId !== price.id) {
    try {
      await stripe.prices.update(oldPriceId, { active: false }, opts);
    } catch (e: any) {
      console.warn('[productStripeSync] archive old price failed (non-fatal):', e?.message);
    }
  }

  return { productId, priceId: price.id, priceCents: displayCents, changed: true };
}
