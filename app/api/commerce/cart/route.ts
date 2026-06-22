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
//   (c2) resolve the optional buyer session (same as /api/orders/request) so the
//       order is stamped with buyer_id (guest stays null), and derive the buyer
//       key used in the idempotency signature.
//   (e) compute per-line deposit (variant.deposit_cents × qty) + fee
//       (round(price_cents × qty × commissionRate)); subtotal/fee/deposit totals.
//       Money math is done BEFORE reserving so the fee-vs-deposit guard and the
//       double-submit dedupe can both run with nothing yet reserved.
//   (e2) FEE GUARD: reject 409 if feeTotalCents ≥ depositTotalCents (a tiny token
//       deposit + the % fee could make application_fee ≥ the charge — Stripe
//       rejects — or route most of the buyer's charge to BHC).
//   (e3) IDEMPOTENCY: derive a STABLE signature from {rancherId + sorted
//       variantId:qty + buyer-session-id-or-ip}. Best-effort dedupe against a
//       recent non-cancelled order with the same line set → reuse it (no new
//       order / reservation / session). The signature also seeds the Stripe
//       idempotency key so a true simultaneous double-submit still reuses ONE
//       session.
//   (d) RESERVE inventory per line; if ANY line fails, release the already-held
//       reservations and return 409 { error, soldOut:true }.
//   (f) createOrder(status 'pending', lines, fee/deposit/subtotal, buyer_id).
//   (g) createCartCheckout(...); updateOrder with the session id.
//   On ANY error after reserving → release every reservation. Never leave stock
//   reserved for a dead session. On the session-id-stamp failure path, release
//   is the DURABLE step: status is left 'pending' until release succeeds so the
//   webhook's checkout.session.expired handler (which only frees 'pending'
//   orders) can recover stranded stock.
//
// Response shape is EXACT (Agent 1A codes against it):
//   success → { checkoutUrl }
//   failure → { error, soldOut? }
//
// Commission applies to ALL on-platform sales (2026-06-20 decision): the fee
// per line = round(unit_price_cents × qty × commissionRate). Mirrors the
// tier_v2 deposit route's gates (app/api/checkout/deposit/route.ts).

import crypto from 'crypto';
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
import { getCommerceDb } from '@/lib/commerce/client';
import { tierFor, TIERS } from '@/lib/tiers';
import { checkOriginGuard } from '@/lib/csrfGuard';
import { resolveBuyerSession } from '@/lib/buyerAuth';
import { getRequestIp } from '@/lib/rateLimit';

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

  // (c2) ── Resolve the optional buyer session ──────────────────────────────
  // Same pattern as /api/orders/request: if the bhc-member-auth cookie resolves,
  // stamp the order with the buyer's Consumers id so it joins to BHC order
  // history; a guest (no/invalid cookie) stays null. A resolver failure is
  // non-fatal — we proceed as a guest rather than block the sale. The resolved
  // id (or the request IP for guests) also seeds the idempotency signature so a
  // double-submit by the SAME buyer/device dedupes.
  let buyerId: string | null = null;
  try {
    const session = await resolveBuyerSession(req);
    if (session?.consumerId) buyerId = session.consumerId;
  } catch (e: any) {
    console.error('[commerce/cart] resolveBuyerSession failed (continuing as guest):', e?.message);
  }
  const buyerKey = buyerId ? `buyer:${buyerId}` : `ip:${getRequestIp(req)}`;

  // (e) ── Money math ───────────────────────────────────────────────────────
  // Per line: deposit = deposit_cents × qty; fee = round(price_cents × qty ×
  // commissionRate). Commission applies to ALL on-platform sales (2026-06-20).
  // Done BEFORE reserving so the fee guard + double-submit dedupe run with
  // nothing reserved yet (a rejection here strands no stock).
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

  // (e2) ── FEE-CAN-DWARF-DEPOSIT guard (money) ─────────────────────────────
  // The buyer's card is charged depositTotalCents + feeTotalCents, and
  // application_fee_amount == feeTotalCents routes to BHC. If the fee ever met
  // or exceeded the deposits sum, Stripe could reject the session (fee ≥ charge
  // is only impossible while deposits > 0) OR — worse — most of the buyer's
  // money would route to BHC instead of the rancher. Latent today (deposits ≈
  // price, fee ≤ ~10%), but a misconfigured token deposit would trip it, so we
  // refuse rather than create a malformed charge. This runs BEFORE reserve, so
  // nothing is held — there is no reservation to release. (If this guard is ever
  // moved below the reserve step, add an `await releaseAllReserved()` here.)
  if (feeTotalCents >= depositTotalCents) {
    console.error(
      '[commerce/cart] PRICING MISCONFIGURED — fee ≥ deposit; refusing checkout.',
      'rancher:', rancherId,
      'feeTotalCents:', feeTotalCents,
      'depositTotalCents:', depositTotalCents,
      'lines:', orderLines.map((l) => `${l.label}×${l.qty}`).join(', '),
    );
    return NextResponse.json({ error: 'Pricing misconfigured — contact the rancher' }, { status: 409 });
  }

  // (e3) ── Idempotency signature (stable across double-submit) ──────────────
  // Seeded on the cart's IDENTITY, not the order id: {rancherId + sorted
  // "variantId:qty" + buyer/ip}. `items` is already coalesced (duplicate
  // variant lines summed) and we sort by variantId so key order can't vary.
  // Two rapid identical POSTs hash to the SAME signature.
  const signaturePayload = [
    rancherId,
    items
      .map((i) => `${i.variantId}:${i.qty}`)
      .sort()
      .join(','),
    buyerKey,
  ].join('|');
  const cartSignature = crypto.createHash('sha256').update(signaturePayload).digest('hex').slice(0, 32);
  // Stable Stripe idempotency key — passed to createCartCheckout so a true
  // simultaneous double-submit (both past the order-dedupe window below before
  // either order lands) still reuses ONE Stripe session.
  const stripeIdempotencyKey = `cart-${cartSignature}`;

  // Best-effort ORDER-level dedupe. We can't add a signature column (this route
  // owns neither the schema nor the repository), so instead of persisting the
  // signature we recompute it: find a RECENT non-cancelled order for this
  // rancher + buyer and compare its line set to this cart. On a match we treat
  // the POST as a duplicate and reuse the first order's Stripe session — no new
  // order, reservation, or charge. Re-calling createCartCheckout with the SAME
  // stable idempotency key returns the original session (no second session is
  // opened). Wrapped so ANY failure here falls through to the normal create
  // path — dedupe is an optimization, never a gate on a real order.
  try {
    const db = getCommerceDb();
    if (db) {
      const sinceIso = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15-min window
      let q = db
        .from('orders')
        .select('id, stripe_checkout_session_id, deposit_cents, fee_cents, subtotal_cents')
        .eq('rancher_id', rancherId)
        .neq('status', 'cancelled')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(10);
      q = buyerId ? q.eq('buyer_id', buyerId) : q.is('buyer_id', null);
      const { data: recent, error: recentErr } = await q;
      if (recentErr) throw new Error(recentErr.message);

      // Cheap pre-filter on totals before the per-order line read.
      const candidates = (recent || []).filter(
        (o: any) =>
          o.deposit_cents === depositTotalCents &&
          o.fee_cents === feeTotalCents &&
          o.subtotal_cents === subtotalCents &&
          o.stripe_checkout_session_id, // only orders that already reached a live session
      );
      // Build this cart's canonical line set once.
      const wantLines = items
        .map((i) => `${i.variantId}:${i.qty}`)
        .sort()
        .join(',');
      for (const cand of candidates) {
        const { data: candLines, error: clErr } = await db
          .from('order_line_items')
          .select('variant_id, qty')
          .eq('order_id', cand.id);
        if (clErr) continue;
        const haveLines = (candLines || [])
          .map((l: any) => `${l.variant_id}:${l.qty}`)
          .sort()
          .join(',');
        if (haveLines !== wantLines) continue;

        // Duplicate confirmed. Reuse the first order's session via the stable
        // key (Stripe returns the original session — no new charge/session).
        const dup = await createCartCheckout({
          rancherConnectAccountId: connectAccountId,
          tier,
          lineItems: checkoutLines,
          applicationFeeCents: feeTotalCents,
          successUrl: `${SITE_URL}/ranchers/${rancherSlug}?order=${cand.id}&checkout=success`,
          cancelUrl: `${SITE_URL}/ranchers/${rancherSlug}?checkout=cancelled`,
          metadata: { orderId: cand.id, rancherId },
          idempotencyKey: stripeIdempotencyKey,
        });
        console.log('[commerce/cart] duplicate submit deduped to existing order', cand.id);
        return NextResponse.json({ checkoutUrl: dup.url });
      }
    }
  } catch (e: any) {
    console.warn('[commerce/cart] duplicate-order dedupe skipped (non-fatal):', e?.message);
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

  // (f) ── Create the pending order (system of record) ──────────────────────
  let order: Awaited<ReturnType<typeof createOrder>>;
  try {
    order = await createOrder({
      rancher_id: rancherId,
      buyer_id: buyerId, // resolved buyer session (Consumers id) or null for guest
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
      successUrl: `${SITE_URL}/ranchers/${rancherSlug}?order=${order.id}&checkout=success`,
      cancelUrl: `${SITE_URL}/ranchers/${rancherSlug}?checkout=cancelled`,
      metadata: { orderId: order.id, rancherId },
      // Stable, cart-identity-derived key (NOT order.id) so a simultaneous
      // double-submit that raced past the dedupe window reuses ONE session.
      idempotencyKey: stripeIdempotencyKey,
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
  //
  // Stamping is idempotent (same value), so on the first failure we RETRY once
  // before tearing the session down — a transient Supabase blip shouldn't cost
  // the buyer a live session + the stock.
  let sessionIdStamped = false;
  let stampErrMsg = '';
  for (let attempt = 0; attempt < 2 && !sessionIdStamped; attempt++) {
    try {
      await updateOrder(order.id, { stripe_checkout_session_id: checkout.sessionId });
      sessionIdStamped = true;
    } catch (e: any) {
      stampErrMsg = e?.message || 'unknown';
      console.error(`[commerce/cart] updateOrder(session id) attempt ${attempt + 1} failed:`, stampErrMsg);
    }
  }

  if (!sessionIdStamped) {
    // The session is live but we couldn't record its id → the webhook can't
    // match it by session id, which would orphan the reservation past expiry.
    // Recovery order matters (inventory durability):
    //   1. Expire the session so Stripe fires checkout.session.expired. The
    //      webhook's expired handler frees stock + cancels — but ONLY while the
    //      order is still 'pending', so we must NOT cancel before release lands.
    //   2. Release the stock HERE as the durable step, tracking per-line success.
    //   3. Mark 'cancelled' ONLY if release fully succeeded. If any line failed
    //      to release, LEAVE the order 'pending' so the webhook's expired path
    //      (from step 1) can re-release and then cancel it — never strand stock
    //      behind an already-'cancelled' order the webhook will skip.
    console.error('[commerce/cart] session-id stamp failed after retry — expiring session + releasing stock:', stampErrMsg);
    try {
      const { expireCheckoutSession } = await import('@/lib/stripeConnect');
      await expireCheckoutSession({ sessionId: checkout.sessionId, connectAccountId });
    } catch (expErr: any) {
      console.error('[commerce/cart] session expire failed — relying on Stripe session TTL + webhook for cleanup:', expErr?.message, 'session:', checkout.sessionId);
    }

    // Strict release: surface whether EVERY reserved line was freed. (The shared
    // releaseAllReserved swallows errors for the fire-and-forget paths; here the
    // outcome decides whether it's safe to cancel.)
    let releaseFullySucceeded = true;
    for (const r of reserved) {
      try {
        await releaseInventory(r.variantId, r.qty, false);
      } catch (relErr: any) {
        releaseFullySucceeded = false;
        console.error('[commerce/cart] release during session-stamp recovery failed:', r.variantId, relErr?.message);
      }
    }

    if (releaseFullySucceeded) {
      // Stock is durably freed — safe to terminalize the order.
      try {
        await updateOrder(order.id, { status: 'cancelled' });
      } catch (uErr: any) {
        // Cancel write failed but stock is already free; the order is a harmless
        // dangling 'pending' that the webhook's expired path will cancel.
        console.error('[commerce/cart] release succeeded but cancel write failed — webhook expired path will finalize:', uErr?.message, 'order:', order.id);
      }
    } else {
      // Release did NOT fully succeed. Leave the order 'pending' on purpose so
      // the webhook's checkout.session.expired handler (gated on 'pending') can
      // recover the stranded stock and then cancel. Cancelling now would make
      // that handler no-op and strand the reservation forever.
      console.error('[commerce/cart] CRITICAL: stock not fully released — leaving order PENDING for webhook recovery. order:', order.id, 'session:', checkout.sessionId);
    }
    return NextResponse.json({ error: 'Could not finalize checkout. Please try again.' }, { status: 500 });
  }

  return NextResponse.json({ checkoutUrl: checkout.url });
}
