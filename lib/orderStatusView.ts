// lib/orderStatusView.ts
//
// Pure view model for the buyer order-status page (/order/<token>).
//
// Everything the page decides — which words describe the state, whether a
// tracking link is renderable, whether to show a ship-to or a pickup address,
// what the promised-by date is — lives here so it is unit-testable without
// Airtable, Next, or a browser. The page component is then a dumb renderer.
//
// HONESTY RULES baked into the copy below (each earned from the rail):
//  - a PICKUP order never says "shipped" or "tracking" (the buyer drove out);
//  - a DEPOSIT order never says "on its way" (the rancher confirms size +
//    balance BEFORE anything moves);
//  - a REFUNDED / CANCELLED order says so plainly and never shows tracking;
//  - a missing tracking number renders NOTHING, never a dead link
//    (carrierTrackingUrl already returns null on garbage).

import { carrierTrackingUrl } from '@/lib/trackingLink';

export type OrderKindView = 'ship' | 'pickup' | 'deposit';
export type OrderStateView = 'new' | 'shipped' | 'delivered' | 'refunded' | 'cancelled';

/** Raw-ish shape: the Airtable field names the page reads, nothing else. */
export interface OrderStatusSource {
  id?: string;
  'Order Ref'?: unknown;
  'Product Name'?: unknown;
  Quantity?: unknown;
  'Buyer Name'?: unknown;
  'Buyer Paid'?: unknown;
  Status?: unknown;
  'Ordered At'?: unknown;
  'Shipped At'?: unknown;
  'Refunded At'?: unknown;
  'Cancelled At'?: unknown;
  'Tracking Number'?: unknown;
  'Shipping Carrier'?: unknown;
  'Ship To Address'?: unknown;
  'Rancher Name'?: unknown;
}

/** The rancher fields the page surfaces (contact + pickup truth). */
export interface RancherContactSource {
  Email?: unknown;
  Phone?: unknown;
  'Pickup Address'?: unknown;
  'Pickup Instructions'?: unknown;
}

export interface OrderStatusView {
  orderId: string;
  productName: string;
  quantity: number;
  buyerFirstName: string;
  buyerPaid: number;
  kind: OrderKindView;
  state: OrderStateView;
  /** Short buyer-facing state word for the badge. */
  statusLabel: string;
  /** One honest sentence under the badge. */
  statusDetail: string;
  orderedAt: string;
  shippedAt: string;
  endedAt: string;
  trackingNumber: string;
  carrier: string;
  /** null ⇒ render nothing; a broken link is worse than no link. */
  trackingUrl: string | null;
  /** Only populated for a ship order that is not terminal. */
  shipTo: string;
  pickupAddress: string;
  pickupInstructions: string;
  rancherName: string;
  rancherEmail: string;
  rancherPhone: string;
  /** ISO date the ranch promised to ship by (Ordered At + Ships In Days). */
  promisedShipBy: string;
  /** true when a ship order is past its promise and still unshipped. */
  runningLate: boolean;
}

const s = (v: unknown) => String(v ?? '').trim();

/** Order Ref carries the ONLY deposit/pickup markers — same parse as the SLA. */
export function orderKindFromRef(orderRef: unknown): OrderKindView {
  const ref = s(orderRef);
  if (ref.includes('DEPOSIT — ')) return 'deposit';
  if (ref.includes('PICKUP — ')) return 'pickup';
  return 'ship';
}

/** Airtable Status → the page's state enum. Unknown/blank ⇒ 'new'. */
export function orderStateFromStatus(status: unknown): OrderStateView {
  switch (s(status)) {
    case 'Shipped':
      return 'shipped';
    case 'Delivered':
      return 'delivered';
    case 'Refunded':
      return 'refunded';
    // 'Canceled' tolerated: Shopify/US spelling shows up in imported data and
    // lib/shopifyCatalogSync already treats both as terminal.
    case 'Cancelled':
    case 'Canceled':
      return 'cancelled';
    default:
      return 'new';
  }
}

/** Ordered At + promised days → ISO date string ('' when either is missing). */
export function promisedShipByIso(orderedAt: unknown, shipsInDays: unknown): string {
  const t = Date.parse(s(orderedAt));
  const days = Number(shipsInDays);
  if (Number.isNaN(t) || !Number.isFinite(days) || days <= 0) return '';
  return new Date(t + days * 24 * 60 * 60 * 1000).toISOString();
}

function copyFor(
  kind: OrderKindView,
  state: OrderStateView,
  rancherName: string,
): { statusLabel: string; statusDetail: string } {
  const ranch = rancherName || 'the ranch';
  if (state === 'refunded') {
    return {
      statusLabel: 'refunded',
      statusDetail: `this order was refunded. the money is on its way back to your card — banks usually take 5 to 10 business days. nothing is shipping.`,
    };
  }
  if (state === 'cancelled') {
    return {
      statusLabel: 'cancelled',
      statusDetail: `this order was cancelled and refunded in full. the money is heading back to your card — banks usually take 5 to 10 business days.`,
    };
  }
  if (kind === 'pickup') {
    return state === 'shipped' || state === 'delivered'
      ? { statusLabel: 'picked up', statusDetail: `you've got it — this pickup is complete.` }
      : {
          statusLabel: 'ready to arrange',
          statusDetail: `paid and confirmed. ${ranch} coordinates the pickup time with you directly — nothing ships.`,
        };
  }
  if (kind === 'deposit') {
    return state === 'shipped' || state === 'delivered'
      ? { statusLabel: 'on the way', statusDetail: `${ranch} sent it out.` }
      : {
          statusLabel: 'deposit in',
          statusDetail: `your deposit is down and counts toward the total. ${ranch} reaches out to confirm your size and the balance before anything ships.`,
        };
  }
  if (state === 'delivered') {
    return { statusLabel: 'delivered', statusDetail: `delivered. if anything showed up wrong, tell us and we make it right.` };
  }
  if (state === 'shipped') {
    return { statusLabel: 'shipped', statusDetail: `${ranch} shipped it. frozen orders travel fast — keep an eye out.` };
  }
  return {
    statusLabel: 'packing up',
    statusDetail: `paid and with ${ranch}. you'll get an email with tracking the moment it leaves the ranch.`,
  };
}

/**
 * Build the whole page view. Never throws; a missing rancher row just drops
 * the contact/pickup blocks (the order itself still renders).
 *
 * `shipsInDays` comes from the product row (may be null) — it is what the
 * checkout promised the buyer, so the page repeats the same promise.
 */
export function buildOrderStatusView(
  order: OrderStatusSource,
  rancher?: RancherContactSource | null,
  shipsInDays?: unknown,
  nowIso?: string,
): OrderStatusView {
  const kind = orderKindFromRef(order['Order Ref']);
  const state = orderStateFromStatus(order.Status);
  const rancherName = s(order['Rancher Name']);
  const { statusLabel, statusDetail } = copyFor(kind, state, rancherName);

  const trackingNumber = kind === 'pickup' ? '' : s(order['Tracking Number']);
  const carrier = s(order['Shipping Carrier']);
  const terminal = state === 'refunded' || state === 'cancelled';

  const orderedAt = s(order['Ordered At']);
  const promisedShipBy = kind === 'ship' ? promisedShipByIso(orderedAt, shipsInDays) : '';
  const now = Date.parse(s(nowIso) || new Date().toISOString());
  const runningLate =
    state === 'new' &&
    kind === 'ship' &&
    !!promisedShipBy &&
    !Number.isNaN(now) &&
    now > Date.parse(promisedShipBy);

  return {
    orderId: s(order.id),
    productName: s(order['Product Name']) || 'your order',
    quantity: Math.max(1, Math.round(Number(order.Quantity || 1)) || 1),
    buyerFirstName: s(order['Buyer Name']).split(/\s+/)[0] || '',
    buyerPaid: Number(order['Buyer Paid'] || 0),
    kind,
    state,
    statusLabel,
    statusDetail,
    orderedAt,
    shippedAt: s(order['Shipped At']),
    endedAt: s(order['Cancelled At']) || s(order['Refunded At']),
    trackingNumber: terminal ? '' : trackingNumber,
    carrier: terminal ? '' : carrier,
    trackingUrl: terminal ? null : carrierTrackingUrl(carrier, trackingNumber),
    shipTo: kind === 'pickup' ? '' : s(order['Ship To Address']),
    pickupAddress: kind === 'pickup' && !terminal ? s(rancher?.['Pickup Address']) : '',
    pickupInstructions: kind === 'pickup' && !terminal ? s(rancher?.['Pickup Instructions']) : '',
    rancherName,
    rancherEmail: s(rancher?.Email),
    rancherPhone: s(rancher?.Phone),
    promisedShipBy,
    runningLate,
  };
}
