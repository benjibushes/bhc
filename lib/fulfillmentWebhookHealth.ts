// Pure selector for the "pushed but never fulfilled" webhook-health check (B2).
//
// Failure class it closes: connectShopifyStore SAVES the connection even when
// fulfillments/* webhook registration fails, and any other cause of the tracking
// webhook not firing leaves an order at External Push Status='pushed' but
// Status='New' with no Tracking Number FOREVER. product-fulfillment-sla
// deliberately EXCLUDES pushed orders (Shopify owns their ship SLA), so nobody
// is ever alerted — the order silently rots. This selector finds those stuck
// pushed orders so the cron can ring the OPERATOR (a BHC-side webhook problem,
// NOT a rancher who forgot to ship — never nag the rancher for this).
//
// "Alerted once" marker: we reuse 'SLA Nudged At'. It is safe to overload here
// because product-fulfillment-sla only ever writes/reads that field on
// *unpushed* orders (its `unpushed` filter drops External Push Status='pushed'),
// so while an order is pushed the SLA cron never touches the field — this check
// owns it. (Documented tradeoff: if an operator later CLEARS a 'pushed' stamp to
// force a manual retry, a stamped 'SLA Nudged At' would suppress that order's
// day-3 rancher nudge once; day-6 escalation still fires. Rare + operator-driven.)

export const PUSHED_STALE_HOURS = 48;

// Statuses that mean the pushed order reached a real terminal/settled state —
// never a webhook-health problem. (The host cron already scans Status='New'
// only, so this is belt-and-suspenders for a reused selector.)
const RESOLVED_STATUSES = new Set(['Shipped', 'Cancelled', 'Refunded']);

export interface PushedOrder {
  id: string;
  status?: string;
  externalPushStatus?: string;
  externalPushedAt?: string;
  /** 'SLA Nudged At' — reused as the "already health-alerted" marker. */
  slaNudgedAt?: string;
}

export interface StalePushedSelection {
  id: string;
  ageHours: number;
}

/**
 * Select pushed orders whose tracking webhook never came back:
 *   External Push Status='pushed'
 *   AND Status not in {Shipped, Cancelled, Refunded}
 *   AND External Pushed At older than PUSHED_STALE_HOURS
 *   AND not already health-alerted (blank 'SLA Nudged At').
 * An unparseable/blank External Pushed At is SKIPPED (can't prove staleness →
 * never alert on a guess).
 */
export function selectStalePushedOrders(orders: PushedOrder[], nowIso: string): StalePushedSelection[] {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) return [];
  const out: StalePushedSelection[] = [];
  for (const o of orders || []) {
    if (!o) continue;
    if (String(o.externalPushStatus || '') !== 'pushed') continue;
    if (RESOLVED_STATUSES.has(String(o.status || ''))) continue;
    if (String(o.slaNudgedAt || '').trim()) continue; // already alerted once
    const pushedAt = Date.parse(String(o.externalPushedAt || ''));
    if (Number.isNaN(pushedAt)) continue;
    const ageHours = (now - pushedAt) / (60 * 60 * 1000);
    if (ageHours >= PUSHED_STALE_HOURS) {
      out.push({ id: o.id, ageHours: Math.floor(ageHours) });
    }
  }
  return out;
}
