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

export interface SlaOrder {
  id: string;
  status?: string;
  orderedAt?: string;
  slaNudgedAt?: string;
}

export interface SlaDecision {
  id: string;
  action: 'nudge' | 'escalate';
  ageDays: number;
}

/**
 * Decide, for each order, whether the cron should nudge the rancher,
 * escalate to the operator, or leave it alone.
 *  - Only Status='New' orders with a parseable Ordered At are considered.
 *  - escalate wins over nudge (an ESCALATE_DAYS-old order that was never
 *    nudged gets ONE escalation, not both mails on the same run).
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
    const ageDays = (now - ordered) / (24 * 60 * 60 * 1000);
    if (ageDays >= ESCALATE_DAYS) {
      out.push({ id: o.id, action: 'escalate', ageDays: Math.floor(ageDays) });
    } else if (ageDays >= NUDGE_DAYS && !o.slaNudgedAt) {
      out.push({ id: o.id, action: 'nudge', ageDays: Math.floor(ageDays) });
    }
  }
  return out;
}
