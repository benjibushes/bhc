// lib/productOrderTermination.ts
//
// Pure gate for KILLING a product order — cancel or refund (shop-chain audit
// 2026-08-01).
//
// The hole this closes: the rancher dashboard offered mark-shipped and
// mark-picked-up and nothing else. There was no refund and no cancel path for
// a rancher OR an admin on a product order — it took the Stripe dashboard,
// after which the Rancher Orders row stayed 'New' until the webhook caught up.
// And 'Cancelled' was read by three modules (fulfillmentPushRunner,
// fulfillmentWebhookHealth, shopifyCatalogSync) and written by nobody, so a
// buyer who changed their mind ten minutes after paying had no path at all.
//
// Everything here is a DECISION, not an effect: the route does auth, the
// money movement, and the reconcile. Keeping the refusals pure means the
// "never refund a shipped box, never double-refund" rules are unit-tested
// rather than argued about in a route body.
//
// FAIL CLOSED is the whole posture: any state we cannot prove is safe refuses.

export type TerminationAction = 'cancel' | 'refund';

export type TerminationRefusalCode =
  | 'bad-action'
  | 'already-shipped'
  | 'already-terminal'
  | 'no-payment-intent';

export interface TerminationOrder {
  /** Rancher Orders 'Status'. */
  status?: unknown;
  /** 'Shipped At' — a stamp here means a box physically left, whatever Status says. */
  shippedAt?: unknown;
  /** 'Stripe Payment Intent' — the ONLY handle on the money. */
  stripePaymentIntent?: unknown;
}

export type TerminationDecision =
  | { ok: true; action: TerminationAction; terminalStatus: 'Cancelled' | 'Refunded'; piId: string }
  | { ok: false; code: TerminationRefusalCode; message: string; status: number };

/** Statuses that mean this order is already finished/reversed. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['Refunded', 'Cancelled', 'Canceled']);
/** Statuses that mean a box already left the ranch. */
export const SHIPPED_STATUSES: ReadonlySet<string> = new Set(['Shipped', 'Delivered']);

const s = (v: unknown) => String(v ?? '').trim();

/**
 * Decide whether this order may be cancelled/refunded, and under which
 * terminal status it should be recorded.
 *
 *  - cancel  → Status 'Cancelled' (the order never happened; money back).
 *  - refund  → Status 'Refunded'  (money back; kept distinct so reporting and
 *              the buyer's copy can tell "I changed my mind" from "something
 *              went wrong").
 *
 * Refuses, in priority order:
 *  1. an action we don't recognise (never guess at a money verb);
 *  2. an order already terminal — double-refunding is the expensive mistake,
 *     so it outranks everything below;
 *  3. an order that shipped (Status OR a 'Shipped At' stamp — either alone is
 *     enough; a box in a truck is not a self-serve refund);
 *  4. an order with no payment intent — with no handle on the charge we
 *     cannot move the money, and flipping the row alone would be a lie.
 */
export function decideTermination(
  order: TerminationOrder,
  action: unknown,
): TerminationDecision {
  const act = s(action).toLowerCase();
  if (act !== 'cancel' && act !== 'refund') {
    return { ok: false, code: 'bad-action', message: 'Unknown action — expected "cancel" or "refund".', status: 400 };
  }

  const status = s(order?.status);
  if (TERMINAL_STATUSES.has(status)) {
    return {
      ok: false,
      code: 'already-terminal',
      message:
        status === 'Refunded'
          ? 'this order was already refunded — the money is on its way back to the buyer.'
          : 'this order was already cancelled — the money is on its way back to the buyer.',
      status: 409,
    };
  }

  if (SHIPPED_STATUSES.has(status) || s(order?.shippedAt)) {
    return {
      ok: false,
      code: 'already-shipped',
      message:
        'this order already shipped — we can’t cancel a box that left the ranch. reply to your order email and a real person will sort it out with the buyer.',
      status: 409,
    };
  }

  const piId = s(order?.stripePaymentIntent);
  if (!piId) {
    return {
      ok: false,
      code: 'no-payment-intent',
      message:
        'we can’t find the payment for this order, so we won’t touch the money. reply to your order email and we’ll handle it by hand.',
      status: 409,
    };
  }

  return {
    ok: true,
    action: act as TerminationAction,
    terminalStatus: act === 'cancel' ? 'Cancelled' : 'Refunded',
    piId,
  };
}
