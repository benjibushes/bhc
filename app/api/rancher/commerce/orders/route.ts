// app/api/rancher/commerce/orders/route.ts — authenticated rancher view over
// their commerce ORDERS + the balance-collection action (Phase-2 fulfillment).
//
// MONEY MODEL (read before touching):
//   A commerce cart (POST /api/commerce/cart) charges the buyer the per-variant
//   DEPOSIT upfront PLUS the BHC commission on the FULL price — both at cart
//   time. An order with status='paid' means that DEPOSIT charge succeeded. The
//   remaining BALANCE the buyer owes the rancher at fulfillment is:
//       balance_cents = subtotal_cents − deposit_cents
//   This balance is 100% the rancher's: NO application_fee. The commission was
//   ALREADY taken on the full price at the cart, so the balance must NOT be
//   commissioned again. createCommerceBalanceCheckout does exactly this (direct
//   charge on the connected account, app_fee 0) — the commerce analog of the
//   cow-share createFinalInvoiceCheckout.
//
// SECURITY MODEL (mirrors app/api/rancher/commerce/route.ts):
//   - rancher_id is ALWAYS taken from the verified session, NEVER the body.
//   - An order is addressed by id (orderId) which a malicious client could forge
//     to point at ANOTHER rancher's order. So collect-balance loads the order
//     and rejects (403) unless order.rancher_id === session.rancherId. Ownership
//     is proven against the session, not asserted by the caller.
//   - Money stays in integer CENTS server-side; the UI rounds to dollars only
//     for display.
//
// BUILD-DARK: getOrdersForRancher / getOrder null-check getCommerceDb(). With no
// commerce DB provisioned, `list` returns [] (the dashboard shows the calm
// placeholder) and collect-balance surfaces a 503. The Stripe charge path is
// additionally gated on STRIPE_CONNECT_ENABLED (like the cart route).

import { NextResponse } from 'next/server';
import { requireRancher } from '@/lib/rancherAuth';
import {
  getOrdersForRancher,
  getOrder,
} from '@/lib/commerce/repository';
import type { Order, OrderLineItem, OrderStatus } from '@/lib/commerce/types';
import { createCommerceBalanceCheckout, getConnectAccountStatus } from '@/lib/stripeConnect';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
// Typo guard ceiling — mirrors the cow-share final-invoice route ($25k).
const MAX_BALANCE_CENTS = 2_500_000;

// Statuses worth surfacing in the rancher's Orders list: 'paid' (deposit paid →
// balance collectable) + 'deposit_paid' (defensive alias for the same upfront-
// paid state in lib/commerce/types). 'balance_invoiced' is kept in the filter
// defensively (so the list still shows such an order if any OTHER surface ever
// sets it) — this route never sets it itself, on purpose: see the no-mutation
// note in collect-balance. 'pending' (no deposit yet), 'cancelled' and
// 'refunded' are excluded — nothing to fulfill / collect.
const LIST_STATUSES: OrderStatus[] = ['paid', 'deposit_paid', 'balance_invoiced'];

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Map the repo's "not configured" throw to a 503 the UI can explain. */
function isUnconfigured(err: unknown): boolean {
  return err instanceof Error && /not configured/i.test(err.message);
}

/** balance the buyer still owes the rancher = subtotal − deposit, floored at 0. */
function balanceCentsOf(order: Pick<Order, 'subtotal_cents' | 'deposit_cents'>): number {
  return Math.max(0, order.subtotal_cents - order.deposit_cents);
}

type OrderWithLines = Order & { order_line_items: OrderLineItem[] };

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
      // ── list ──────────────────────────────────────────────────────────────
      // Balance-relevant orders for THIS rancher (session-scoped), newest first,
      // with line items + the computed balance. Empty array on an unconfigured
      // DB (build-dark) OR a rancher with no orders yet — the UI treats both the
      // same (calm "No orders yet" placeholder).
      case 'list': {
        const orders = (await getOrdersForRancher(rancherId, {
          statuses: LIST_STATUSES,
        })) as OrderWithLines[];
        // Decorate each order with its computed balance so the UI never has to
        // re-derive the money math (single source of truth = the server).
        const decorated = orders.map((o) => ({
          ...o,
          balance_cents: balanceCentsOf(o),
        }));
        return NextResponse.json({ orders: decorated });
      }

      // ── collect-balance ─────────────────────────────────────────────────────
      // Create a direct-charge balance Checkout Session for the rancher to send
      // the buyer. The session has NO application_fee (commission already taken
      // at the cart). Returns { checkoutUrl }.
      case 'collect-balance': {
        // The Stripe charge path is gated like the cart route. (list stays open
        // so the dashboard can render build-dark.)
        if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
          return bad('Commerce checkout not enabled', 503);
        }

        const orderId = String(body.orderId || body.order_id || '').trim();
        if (!orderId) return bad('orderId is required.');

        // Load the order. getOrder returns null on unconfigured DB → 503 below.
        const order = await getOrder(orderId);
        if (!order) {
          // Could be a genuinely missing id OR build-dark. Treat a null on an
          // unconfigured DB as 503; otherwise 404.
          return bad('Order not found.', 404);
        }

        // OWNERSHIP — the order must belong to the session rancher. Reject a
        // forged id pointing at someone else's order. 403, never 404, so the
        // rancher can't probe which order ids exist across tenants.
        if (order.rancher_id !== rancherId) {
          return bad('That order is not yours.', 403);
        }

        // GUARD — only a deposit-paid order with a positive balance can be
        // collected. 409 otherwise (nothing owed / wrong state). 'paid' is the
        // deposit-paid state for a commerce order; 'deposit_paid' accepted
        // defensively as its alias. We DON'T move the order off 'paid' (see the
        // no-mutation note at the createCommerceBalanceCheckout call below), so a
        // re-tap of "Collect balance" re-enters here cleanly and the idempotent
        // Stripe key returns the SAME balance session — the rancher just gets the
        // link again.
        const collectable = order.status === 'paid' || order.status === 'deposit_paid';
        if (!collectable) {
          return bad(
            `This order is "${order.status}" — only a deposit-paid order with a balance owed can be collected.`,
            409,
          );
        }

        const balanceCents = balanceCentsOf(order);
        if (balanceCents <= 0) {
          return bad('This order has no balance owed — nothing to collect.', 409);
        }
        if (balanceCents > MAX_BALANCE_CENTS) {
          // Defensive typo guard — a malformed order shouldn't mint a huge charge.
          return bad(
            `Balance exceeds the $${(MAX_BALANCE_CENTS / 100).toLocaleString()} ceiling. Contact support.`,
            409,
          );
        }

        // Resolve the rancher's Stripe Connect account SERVER-SIDE from the
        // Airtable record (never trusted from the body) — same source as the
        // cart + final-invoice routes.
        let rancher: any;
        try {
          rancher = await getRecordById(TABLES.RANCHERS, rancherId);
        } catch {
          return bad('Could not load your account.', 500);
        }
        if (!rancher) return bad('Rancher not found.', 404);

        if (String(rancher['Stripe Connect Status'] || '') !== 'active') {
          return bad('Your bank isn’t connected yet — finish Stripe onboarding before collecting balances.', 409);
        }
        const connectAccountId = String(rancher['Stripe Connect Account Id'] || '');
        if (!connectAccountId) {
          return bad('Your Stripe Connect account is missing — finish onboarding first.', 409);
        }

        // Live Connect re-check (mirror the cart route): the cached field can go
        // stale if Stripe flips active→restricted and the webhook misses it. Read
        // live, self-heal Airtable, reject with the same 409. A transient Stripe
        // read failure falls back to the cached 'active' validated above (never
        // block on a flaky read).
        try {
          const live = await getConnectAccountStatus(connectAccountId);
          if (live.status !== 'active') {
            try {
              await updateRecord(TABLES.RANCHERS, rancherId, { 'Stripe Connect Status': live.status });
            } catch (persistErr: any) {
              console.error('[rancher/commerce/orders] failed to persist corrected Connect status:', persistErr?.message);
            }
            return bad('Your bank isn’t connected yet — finish Stripe onboarding before collecting balances.', 409);
          }
        } catch (statusErr: any) {
          console.error('[rancher/commerce/orders] live Connect status read failed — using cached field:', statusErr?.message);
        }

        // Best-effort buyer email so Stripe pre-fills it (Checkout collects it
        // otherwise). Resolved from the linked Consumers record; never fatal.
        let buyerEmail: string | undefined;
        if (order.buyer_id) {
          try {
            const consumer: any = await getRecordById(TABLES.CONSUMERS, order.buyer_id);
            const e = consumer && typeof consumer['Email'] === 'string' ? consumer['Email'].trim() : '';
            if (e) buyerEmail = e;
          } catch {
            // Guest order or lookup miss — proceed without a prefilled email.
          }
        }

        // Create the balance Checkout Session (direct charge, app_fee 0).
        let checkout: { url: string; sessionId: string };
        try {
          checkout = await createCommerceBalanceCheckout({
            rancherConnectAccountId: connectAccountId,
            orderId: order.id,
            balanceCents,
            buyerEmail,
            successUrl: `${SITE_URL}/member?order=${order.id}&balance=paid`,
            cancelUrl: `${SITE_URL}/member?order=${order.id}&balance=cancelled`,
            metadata: { orderId: order.id, rancherId },
          });
        } catch (e: any) {
          console.error('[rancher/commerce/orders] createCommerceBalanceCheckout failed:', e?.message);
          return bad('Could not create the balance checkout. Please try again.', 500);
        }

        // DELIBERATELY NO order mutation here. We do NOT flip the status off
        // 'paid' and we do NOT overwrite stripe_checkout_session_id with the
        // balance session. Reason (webhook is owned elsewhere + must not change):
        // the shared commerce settle path treats ONLY {paid, cancelled, refunded}
        // as terminal. If we moved the order to 'balance_invoiced', a later Stripe
        // REDELIVERY of the deposit's checkout.session.completed / pi.succeeded
        // (matched by the still-stored deposit session id / PI id) would fall
        // through that skip-set and CONSUME inventory a second time. Likewise,
        // overwriting the session id with the balance session would make the
        // balance's own checkout.session.completed match this order and re-run the
        // consume. The balance is a rancher-direct charge with no platform
        // settlement (inventory was already consumed when the deposit settled to
        // 'paid'), so the correct behavior is for the webhook to ignore the balance
        // session entirely — which it does as long as that session id is never
        // stored. The rancher gets the link from the response; the idempotency key
        // (commerce-balance-${orderId}) makes a re-tap return the SAME session.
        return NextResponse.json({
          checkoutUrl: checkout.url,
          balanceCents,
        });
      }

      default:
        return bad(`Unknown action "${action}".`);
    }
  } catch (err: any) {
    if (isUnconfigured(err)) {
      // Build-dark: DB not provisioned. The UI shows the rollout placeholder.
      return NextResponse.json(
        { error: 'Order tools are not switched on yet.' },
        { status: 503 },
      );
    }
    console.error('[rancher/commerce/orders] error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to load orders.' }, { status: 500 });
  }
}
