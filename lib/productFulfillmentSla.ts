// lib/productFulfillmentSla.ts
//
// Pure selection logic for the product fulfillment-SLA cron (backlog #112 /
// checkout audit 2026-07-14). A PAID order sitting in Status='New' had no
// chaser: fulfillment-chase watches the deposit/referral rail only, and
// product-review-ask only looks at already-Shipped orders. A rancher who
// never marks Shipped left a paid buyer waiting indefinitely, invisibly.
//
// Policy: nudge the rancher when a New order is older than NUDGE_DAYS;
// escalate to the operator when older than ESCALATE_DAYS. One nudge per
// order ever (the cron stamps 'SLA Nudged At'); escalation dedupes via the
// operator-signal dedupeKey instead of a field.

export const NUDGE_DAYS = 3;
export const ESCALATE_DAYS = 6;

// ── THE RANCHER'S OWN PROMISE (shop-chain audit 2026-08-01) ─────────────────
// 'Ships In Days' is quoted to the buyer at checkout ("ships from the ranch
// within ~N days" — app/shop/checkout/[id]/page.tsx) and was then compared
// against NOTHING: this module used a flat 3/6 for every ship order. So a
// rancher who promised 1 day wasn't nudged until day 3 (the buyer was already
// two days past the promise and we were silent), and one who promised 14 got
// nudged on day 3 for an order that is perfectly on time — which is how a
// rancher learns to ignore our emails.
//
// With a promise on file the windows ride it: one grace day before we nudge,
// four before we escalate (the same nudge→escalate gap as the flat rail). No
// promise on file ⇒ the flat 3/6 above, byte-identical to before.
export const PROMISE_NUDGE_GRACE_DAYS = 1;
export const PROMISE_ESCALATE_GRACE_DAYS = 4;

// Wave C (2026-07-14): deposit-style and pickup orders are SUPPOSED to sit in
// 'New' far longer than a ship order — the deposit settle email says "do not
// ship yet — confirm size + settle the balance", and pickups wait until the
// buyer drives out. The ship windows above false-fired "waiting to ship" on
// day 3 and a LOUD "refund the buyer — chargeback forming" every 48h from day
// 6 on healthy orders, training both sides to ignore the alarm that matters.
export const SLOW_NUDGE_DAYS = 7;
export const SLOW_ESCALATE_DAYS = 14;

export type SlaOrderKind = 'ship' | 'deposit' | 'pickup';

/**
 * Classify an order by its Order Ref markers — the ONLY place the deposit/
 * pickup nature is recorded (settlement stamps 'DEPOSIT — ' / 'PICKUP — '
 * prefixes; same parsing as app/api/rancher/orders/route.ts). Uses .includes
 * because the prefixes compound ('DEPOSIT — PICKUP — '); deposit wins on a
 * compound ref since confirming size + balance precedes the pickup.
 */
export function orderKind(orderRef: string | undefined | null): SlaOrderKind {
  const ref = String(orderRef || '');
  if (ref.includes('DEPOSIT — ')) return 'deposit';
  if (ref.includes('PICKUP — ')) return 'pickup';
  return 'ship';
}

export interface SlaOrder {
  id: string;
  status?: string;
  orderedAt?: string;
  slaNudgedAt?: string;
  /** Raw 'Order Ref' — carries the DEPOSIT/PICKUP markers (see orderKind). */
  orderRef?: string;
  /**
   * The product's 'Ships In Days' — what checkout promised this buyer.
   * Undefined/0/garbage ⇒ flat windows (see PROMISE_*_GRACE_DAYS).
   */
  promisedShipDays?: number | null;
  /**
   * 'Buyer Delay Notified At' — set once we've told the BUYER their order is
   * running late. Non-blank suppresses that mail forever (one per order).
   */
  buyerNotifiedAt?: string;
}

export interface SlaDecision {
  id: string;
  action: 'nudge' | 'escalate';
  ageDays: number;
  /** Drives kind-specific copy: never tell a rancher to SHIP a deposit. */
  kind: SlaOrderKind;
  /**
   * The buyer has paid and heard nothing for the whole escalate window, and
   * we have never told them. The cron sends ONE honest "we're on it" note.
   * False on every nudge and on every already-notified order.
   */
  notifyBuyer: boolean;
}

/**
 * The nudge/escalate day-thresholds for one order. Extracted so the promise
 * arithmetic is testable on its own and the cron can quote the real numbers
 * in its copy instead of the flat constants.
 */
export function slaWindowFor(
  kind: SlaOrderKind,
  promisedShipDays?: number | null,
): { nudgeDays: number; escalateDays: number; fromPromise: boolean } {
  // Deposit/pickup orders dwell in 'New' by design and have no ship promise
  // to ride — they keep the slow windows whatever the product says.
  if (kind !== 'ship') {
    return { nudgeDays: SLOW_NUDGE_DAYS, escalateDays: SLOW_ESCALATE_DAYS, fromPromise: false };
  }
  const promised = Number(promisedShipDays);
  if (Number.isFinite(promised) && promised > 0) {
    return {
      nudgeDays: promised + PROMISE_NUDGE_GRACE_DAYS,
      escalateDays: promised + PROMISE_ESCALATE_GRACE_DAYS,
      fromPromise: true,
    };
  }
  return { nudgeDays: NUDGE_DAYS, escalateDays: ESCALATE_DAYS, fromPromise: false };
}

/**
 * Decide, for each order, whether the cron should nudge the rancher,
 * escalate to the operator, or leave it alone.
 *  - Only Status='New' orders with a parseable Ordered At are considered.
 *  - 'ship' orders ride the rancher's own 'Ships In Days' promise when it is
 *    set, else the flat NUDGE/ESCALATE windows; 'deposit'/'pickup' ride the
 *    slow windows (they legitimately dwell in New).
 *  - escalate wins over nudge (an escalate-age order that was never nudged
 *    gets ONE escalation, not both mails on the same run).
 *  - already-nudged orders can still escalate, but never re-nudge.
 *  - notifyBuyer rides the escalate decision and is one-shot per order.
 */
export function slaDecisions(orders: SlaOrder[], nowIso: string): SlaDecision[] {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) return [];
  const out: SlaDecision[] = [];
  for (const o of orders || []) {
    if (!o || String(o.status || '') !== 'New') continue;
    const ordered = Date.parse(String(o.orderedAt || ''));
    if (Number.isNaN(ordered)) continue;
    const kind = orderKind(o.orderRef);
    const { nudgeDays, escalateDays } = slaWindowFor(kind, o.promisedShipDays);
    const ageDays = (now - ordered) / (24 * 60 * 60 * 1000);
    if (ageDays >= escalateDays) {
      out.push({
        id: o.id,
        action: 'escalate',
        ageDays: Math.floor(ageDays),
        kind,
        // The buyer paid and has heard nothing for the whole window. Tell them
        // once, ever — the cron stamps 'Buyer Delay Notified At' and verifies
        // the stamp persisted BEFORE sending, so a missing field means zero
        // mails rather than one every run.
        notifyBuyer: !String(o.buyerNotifiedAt || '').trim(),
      });
    } else if (ageDays >= nudgeDays && !o.slaNudgedAt) {
      out.push({ id: o.id, action: 'nudge', ageDays: Math.floor(ageDays), kind, notifyBuyer: false });
    }
  }
  return out;
}
