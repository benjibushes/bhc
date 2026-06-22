// Phase 1B — commerce cart checkout + inventory reservation (the MONEY path).
//
// POST body: { rancherSlug: string, items: [{ variantId: string, qty: number }] }
//
// Single-rancher cart only. Flow:
//   (a) STRIPE_CONNECT_ENABLED gate (503) + CSRF Origin guard (403).
//   (b) resolve rancher by slug; tier_v2 + Connect-active (LIVE recheck) +
//       subscription gates → 409 with a clear error if ineligible.
//   (c) resolve variants; verify EACH variant's product belongs to this rancher
//       (reject cross-rancher / mixed-rancher carts).
//   (d) RESERVE inventory per line; if ANY line fails, release the already-held
//       reservations and return 409 { error, soldOut:true }.
//   (e) compute per-line deposit (variant.deposit_cents × qty) + fee
//       (round(price_cents × qty × commissionRate)); subtotal/fee/deposit totals.
//   (f) createOrder(status 'pending', lines, fee/deposit/subtotal).
//   (g) createCartCheckout(...); updateOrder with the session id.
//   On ANY error after reserving → release every reservation. Never leave stock
//   reserved for a dead session.
//
// Response shape is EXACT (Agent 1A codes against it):
//   success → { checkoutUrl }
//   failure → { error, soldOut? }
//
// Commission applies to ALL on-platform sales (2026-06-20 decision): the fee
// per line = round(unit_price_cents × qty × commissionRate). Mirrors the
// tier_v2 deposit route's gates (app/api/checkout/deposit/route.ts).

import { NextResponse } from 'next/server';
import { getRancherBySlug, updateRecord, TABLES } from '@/lib/airtable';
import { createCartCheckout, getConnectAccountStatus, type CartCheckoutLineItem } from '@/lib/stripeConnect';
import {
  getVariantsByIds,
  getVariantWithProduct,
  reserveInventory,
  releaseInventory,
  createOrder,
  updateOrder,
  type NewOrderLine,
} from '@/lib/commerce/repository';
import { tierFor, TIERS } from '@/lib/tiers';
import { checkOriginGuard } from '@/lib/csrfGuard';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

interface CartItemInput {
  variantId: string;
  qty: number;
}

export async function POST(req: Request) {
  // (a) Build-dark / kill-switch gate — identical to the deposit route.
  if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
    return NextResponse.json({ error: 'Commerce checkout not enabled' }, { status: 503 });
  }

  // CSRF defense-in-depth — Origin allowlist on top of SameSite=lax cookies.
  const originCheck = checkOriginGuard(req);
  if (!originCheck.ok && originCheck.response) return originCheck.response;

  // ── Parse + validate body ────────────────────────────────────────────────
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const rancherSlug = String(body?.rancherSlug || '').trim();
  if (!rancherSlug) {
    return NextResponse.json({ error: 'rancherSlug required' }, { status: 400 });
  }

  const rawItems: any[] = Array.isArray(body?.items) ? body.items : [];
  if (rawItems.length === 0) {
    return NextResponse.json({ error: 'Cart is empty' }, { status: 400 });
  }

  // Abuse caps: bound distinct items + per-variant qty so a forged cart can't
  // build an absurd Stripe session (esp. on an unlimited/no-inventory variant
  // where the reserve RPC won't stop a giant qty) or fan out an N-query loop.
  const MAX_ITEMS = 20;
  const MAX_QTY_PER_VARIANT = 50;
  if (rawItems.length > MAX_ITEMS) {
    return NextResponse.json({ error: `Too many items in cart (max ${MAX_ITEMS}).` }, { status: 400 });
  }

  // Normalize + coalesce duplicate variant lines (a buyer adding the same
  // variant twice must reserve the SUM, not race two partial reserves on the
  // same row). Integer qty ≥ 1, capped per variant.
  const qtyByVariant = new Map<string, number>();
  for (const raw of rawItems) {
    const variantId = String(raw?.variantId || '').trim();
    const qty = Math.floor(Number(raw?.qty));
    if (!variantId || !Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json({ error: 'Each item needs a variantId and a positive integer qty' }, { status: 400 });
    }
    const running = (qtyByVariant.get(variantId) || 0) + qty;
    if (running > MAX_QTY_PER_VARIANT) {
      return NextResponse.json({ error: `Max ${MAX_QTY_PER_VARIANT} per item.` }, { status: 400 });
    }
    qtyByVariant.set(variantId, running);
  }
  const items: CartItemInput[] = Array.from(qtyByVariant.entries()).map(([variantId, qty]) => ({ variantId, qty }));

  // (b) ── Resolve rancher by slug ──────────────────────────────────────────
  let rancher: any;
  try {
    rancher = await getRancherBySlug(rancherSlug);
  } catch {
    return NextResponse.json({ error: 'Could not load rancher' }, { status: 500 });
  }
  if (!rancher) {
    return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
  }
  const rancherId: string = rancher.id;

  // ── tier_v2 + Connect + subscription gates (mirror the deposit route) ─────
  const pricingModel = String(rancher['Pricing Model'] || 'legacy');
  if (pricingModel !== 'tier_v2') {
    return NextResponse.json(
      { error: 'This ranch is not set up for on-platform checkout yet.' },
      { status: 409 },
    );
  }

  const tier = tierFor(rancher);
  if (!tier) {
    return NextResponse.json({ error: 'Rancher tier not set — cannot accept orders yet' }, { status: 409 });
  }

  if (String(rancher['Stripe Connect Status'] || '') !== 'active') {
    return NextResponse.json({ error: 'Rancher bank not connected — cannot accept orders yet' }, { status: 409 });
  }
  const connectAccountId = String(rancher['Stripe Connect Account Id'] || '');
  if (!connectAccountId) {
    return NextResponse.json({ error: 'Rancher Stripe Connect Account missing' }, { status: 409 });
  }

  // Live Connect status re-check — the cached field can go stale when Stripe
  // flips active→restricted and the Connect webhook misses it. Read live,
  // self-heal Airtable, reject with the SAME 409. A transient Stripe read
  // failure falls back to the cached 'active' validated above (never block an
  // order on a flaky Stripe read).
  try {
    const live = await getConnectAccountStatus(connectAccountId);
    if (live.status !== 'active') {
      try {
        await updateRecord(TABLES.RANCHERS, rancherId, { 'Stripe Connect Status': live.status });
      } catch (persistErr: any) {
        console.error('[commerce/cart] failed to persist corrected Connect status:', persistErr?.message);
      }
      return NextResponse.json({ error: 'Rancher bank not connected — cannot accept orders yet' }, { status: 409 });
    }
  } catch (statusErr: any) {
    console.error('[commerce/cart] live Connect status read failed — falling back to cached field:', statusErr?.message);
  }

  // Subscription status gate — past_due/unpaid/canceled ranchers can't sell.
  const subscriptionStatus = String(rancher['Subscription Status'] || '');
  if (subscriptionStatus === 'past_due' || subscriptionStatus === 'unpaid' || subscriptionStatus === 'canceled') {
    return NextResponse.json(
      { error: `Rancher subscription is ${subscriptionStatus} — checkout temporarily unavailable. Please contact hello@buyhalfcow.com.` },
      { status: 409 },
    );
  }

  // (c) ── Resolve variants + verify each belongs to THIS rancher ───────────
  let variants: Awaited<ReturnType<typeof getVariantsByIds>>;
  try {
    variants = await getVariantsByIds(items.map((i) => i.variantId));
  } catch (e: any) {
    console.error('[commerce/cart] getVariantsByIds failed:', e?.message);
    return NextResponse.json({ error: 'Could not load cart items' }, { status: 500 });
  }

  const variantById = new Map(variants.map((v) => [v.id, v]));
  // Every requested variant must exist.
  for (const item of items) {
    if (!variantById.has(item.variantId)) {
      return NextResponse.json({ error: 'One or more items are no longer available' }, { status: 409 });
    }
  }

  // Cross-rancher guard: resolve each variant's product and confirm its
  // rancher_id === this rancher. Rejects mixed-rancher carts (multi-rancher =
  // future separate charges&transfers) AND any variant that simply isn't this
  // rancher's. getVariantWithProduct joins product → rancher_id.
  for (const item of items) {
    let joined: Awaited<ReturnType<typeof getVariantWithProduct>>;
    try {
      joined = await getVariantWithProduct(item.variantId);
    } catch (e: any) {
      console.error('[commerce/cart] getVariantWithProduct failed:', e?.message);
      return NextResponse.json({ error: 'Could not verify cart items' }, { status: 500 });
    }
    if (!joined || joined.product.rancher_id !== rancherId) {
      // Mixed-rancher or stranger variant — reject the whole cart. Nothing
      // reserved yet, so no release needed.
      return NextResponse.json(
        { error: 'All items in a cart must come from the same ranch.' },
        { status: 409 },
      );
    }
  }

  // (d) ── Reserve inventory per line; release-on-any-failure ────────────────
  // Reserve BEFORE creating the Stripe session. Track every successful
  // reservation so we can release on the partial-failure path (and on any
  // later error / the webhook expiry path).
  const reserved: { variantId: string; qty: number }[] = [];

  // Helper: release everything reserved so far. Best-effort per line — one
  // failed release must not prevent releasing the rest. Never leaves stock
  // held for a dead request.
  const releaseAllReserved = async () => {
    for (const r of reserved) {
      try {
        await releaseInventory(r.variantId, r.qty, false);
      } catch (relErr: any) {
        console.error('[commerce/cart] releaseInventory failed during rollback:', r.variantId, relErr?.message);
      }
    }
  };

  for (const item of items) {
    let ok = false;
    try {
      ok = await reserveInventory(item.variantId, item.qty);
    } catch (e: any) {
      // A reserve THREW (DB error) — roll back the prior reservations, fail.
      console.error('[commerce/cart] reserveInventory threw:', item.variantId, e?.message);
      await releaseAllReserved();
      return NextResponse.json({ error: 'Could not reserve inventory. Please try again.' }, { status: 500 });
    }
    if (!ok) {
      // Insufficient stock for this line. Release the ones already reserved.
      await releaseAllReserved();
      const v = variantById.get(item.variantId);
      return NextResponse.json(
        { error: `Sold out: ${v?.label || 'an item'} doesn't have enough stock for your order.`, soldOut: true },
        { status: 409 },
      );
    }
    reserved.push({ variantId: item.variantId, qty: item.qty });
  }

  // From here on, ANY failure path MUST releaseAllReserved() before returning.

  // (e) ── Money math ───────────────────────────────────────────────────────
  // Per line: deposit = deposit_cents × qty; fee = round(price_cents × qty ×
  // commissionRate). Commission applies to ALL on-platform sales (2026-06-20).
  const commissionRate = TIERS[tier].commissionRate;

  let subtotalCents = 0;   // Σ price_cents × qty (full sale value)
  let depositTotalCents = 0; // Σ deposit_cents × qty (charged now)
  let feeTotalCents = 0;     // Σ round(price_cents × qty × rate) — the application fee

  const orderLines: NewOrderLine[] = [];
  const checkoutLines: CartCheckoutLineItem[] = [];

  for (const item of items) {
    const v = variantById.get(item.variantId)!;
    const lineSubtotal = v.price_cents * item.qty;
    const lineDeposit = v.deposit_cents * item.qty;
    const lineFee = Math.round(v.price_cents * item.qty * commissionRate);

    subtotalCents += lineSubtotal;
    depositTotalCents += lineDeposit;
    feeTotalCents += lineFee;

    orderLines.push({
      variant_id: v.id,
      label: v.label,
      qty: item.qty,
      unit_price_cents: v.price_cents,
      fee_cents: lineFee,
    });
    checkoutLines.push({
      label: v.label,
      depositCents: v.deposit_cents,
      fullPriceCents: v.price_cents,
      qty: item.qty,
    });
  }

  // (f) ── Create the pending order (system of record) ──────────────────────
  let order: Awaited<ReturnType<typeof createOrder>>;
  try {
    order = await createOrder({
      rancher_id: rancherId,
      status: 'pending',
      subtotal_cents: subtotalCents,
      fee_cents: feeTotalCents,
      deposit_cents: depositTotalCents,
      lines: orderLines,
    });
  } catch (e: any) {
    console.error('[commerce/cart] createOrder failed:', e?.message);
    await releaseAllReserved();
    return NextResponse.json({ error: 'Could not create order. Please try again.' }, { status: 500 });
  }

  // (g) ── Create the Stripe Checkout Session on the rancher's Connect acct ──
  // No buyer email is collected by this route (body is only { rancherSlug,
  // items }) — Stripe Checkout captures the buyer's email + address itself
  // (automatic_tax needs the address anyway), so buyerEmail is left unset.
  let checkout: { url: string; sessionId: string };
  try {
    checkout = await createCartCheckout({
      rancherConnectAccountId: connectAccountId,
      tier,
      lineItems: checkoutLines,
      applicationFeeCents: feeTotalCents,
      successUrl: `${SITE_URL}/${rancherSlug}?order=${order.id}&checkout=success`,
      cancelUrl: `${SITE_URL}/${rancherSlug}?checkout=cancelled`,
      metadata: { orderId: order.id, rancherId },
    });
  } catch (e: any) {
    // Stripe session create failed AFTER the order row + reservations exist.
    // Release the stock, mark the order cancelled so it's not a dangling
    // 'pending', and fail. (The webhook expiry path won't fire — no session.)
    console.error('[commerce/cart] createCartCheckout failed:', e?.message);
    await releaseAllReserved();
    try {
      await updateOrder(order.id, { status: 'cancelled' });
    } catch (uErr: any) {
      console.error('[commerce/cart] could not mark order cancelled after Stripe failure:', uErr?.message);
    }
    return NextResponse.json({ error: 'Checkout failed. Please try again.' }, { status: 500 });
  }

  // Stamp the session id so the webhook (checkout.session.completed/expired)
  // can find this order via getOrderByCheckoutSession.
  try {
    await updateOrder(order.id, { stripe_checkout_session_id: checkout.sessionId });
  } catch (e: any) {
    // The session is live but we couldn't record its id → the webhook can't
    // match it, which would orphan the reservation past expiry. Expire the
    // session now + release the stock so nothing is left held for a session we
    // can't reconcile.
    console.error('[commerce/cart] updateOrder(session id) failed — expiring session + releasing stock:', e?.message);
    try {
      const { expireCheckoutSession } = await import('@/lib/stripeConnect');
      await expireCheckoutSession({ sessionId: checkout.sessionId, connectAccountId });
    } catch (expErr: any) {
      console.error('[commerce/cart] CRITICAL: session expire also failed — orphan reservation risk:', expErr?.message, 'session:', checkout.sessionId);
    }
    await releaseAllReserved();
    try {
      await updateOrder(order.id, { status: 'cancelled' });
    } catch {}
    return NextResponse.json({ error: 'Could not finalize checkout. Please try again.' }, { status: 500 });
  }

  return NextResponse.json({ checkoutUrl: checkout.url });
}
