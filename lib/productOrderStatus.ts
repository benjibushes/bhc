// lib/productOrderStatus.ts — the shop rail's terminal-status set, alone.
//
// EXTRACTED (2026-08-19) from lib/productSettlement, which imports Airtable,
// Stripe, email, Meta CAPI and the settlement error types. The pure money
// readers — lib/bhcRevenue, and anything else that has to answer "did this
// order actually earn?" — cannot drag that graph in, and the alternative
// (hand-copying three strings into a second place) is exactly how a refunded
// order goes on being counted as revenue somewhere. Hermetic: zero imports.

/**
 * Statuses that mean the order is OVER and earned nothing.
 *
 * The refund path flips Status and stamps 'Refunded At' but deliberately
 * leaves 'BHC Margin' intact — the field records what the sale WAS, so any
 * margin sum without this filter keeps counting money that went back out.
 * 'Canceled' is the imported/US spelling that lib/shopifyCatalogSync emits.
 */
export const TERMINAL_PRODUCT_ORDER_STATUSES: ReadonlySet<string> = new Set([
  'Refunded',
  'Cancelled',
  'Canceled',
]);
