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
}

export interface SlaDecision {
  id: string;
  action: 'nudge' | 'escalate';
  ageDays: number;
  /** Drives kind-specific copy: never tell a rancher to SHIP a deposit. */
  kind: SlaOrderKind;
}

/**
 * Decide, for each order, whether the cron should nudge the rancher,
 * escalate to the operator, or leave it alone.
 *  - Only Status='New' orders with a parseable Ordered At are considered.
 *  - 'ship' orders keep the tight NUDGE/ESCALATE windows; 'deposit'/'pickup'
 *    ride the slow windows (they legitimately dwell in New).
 *  - escalate wins over nudge (an escalate-age order that was never nudged
 *    gets ONE escalation, not both mails on the same run).
 *  - already-nudged orders can still escalate, but never re-nudge.
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
    const nudgeDays = kind === 'ship' ? NUDGE_DAYS : SLOW_NUDGE_DAYS;
    const escalateDays = kind === 'ship' ? ESCALATE_DAYS : SLOW_ESCALATE_DAYS;
    const ageDays = (now - ordered) / (24 * 60 * 60 * 1000);
    if (ageDays >= escalateDays) {
      out.push({ id: o.id, action: 'escalate', ageDays: Math.floor(ageDays), kind });
    } else if (ageDays >= nudgeDays && !o.slaNudgedAt) {
      out.push({ id: o.id, action: 'nudge', ageDays: Math.floor(ageDays), kind });
    }
  }
  return out;
}
