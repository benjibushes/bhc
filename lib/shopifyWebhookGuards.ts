// Pure guards for the Shopify webhook (app/api/webhooks/shopify/route.ts).
//
// Batch D hardening (defense-in-depth + observability). Every decision here is
// a pure, tested function so a silent revert on the security/correctness path
// surfaces in lib/shopifyWebhookGuards.test.ts rather than in production.
//
//   L5  buildScopedFulfillmentOrderFilter — a fulfillment stamp must find the
//       order row scoped to the HMAC-verified rancher, never by order id alone
//       (a rancher whose HMAC verified could otherwise stamp ANOTHER rancher's
//       row that happens to carry the same External Order Id).
//   L6  shopifyWebhookRateLimitKey — per-source bucket for the unauthenticated
//       pre-HMAC rancher-resolution full-scan (paired in the route with an
//       isValidShopDomain format reject).
//   L7  catalogSyncReportIndicatesFailure — a products/update-triggered resync
//       that fails / partially fails must alert, not silently 200.
//   L8  resolveFulfillmentStampPatch — fulfillments/update OVERWRITES a
//       corrected tracking number; fulfillments/create only fills an empty one.

import { escapeAirtableValue } from './airtable';

// ── L5: cross-tenant stamping guard ─────────────────────────────────────────
// The fulfillment handler resolves + HMAC-verifies the rancher from the shop
// header, then looks up the order to stamp. Scoping that lookup to the SAME
// rancher (AND-combined) means a verified rancher can only ever stamp their own
// order rows, even if two stores collide on an External Order Id.
export function buildScopedFulfillmentOrderFilter(externalOrderId: string, rancherId: string): string {
  const orderId = escapeAirtableValue(String(externalOrderId || ''));
  const rancher = escapeAirtableValue(String(rancherId || ''));
  return `AND({External Order Id} = "${orderId}", {Rancher Record ID} = "${rancher}")`;
}

// ── L6: rate-limit bucket for the pre-HMAC full-scan ────────────────────────
// Bucket by SOURCE IP, not shop: the shop header is attacker-controllable
// before HMAC, so keying on it lets an attacker rotate shop values for a fresh
// bucket each time. getTrustedClientIp uses platform-set headers an attacker
// cannot forge on Vercel, so a per-IP bucket actually bounds a single-source
// flood of the unauthenticated Airtable scan.
export function shopifyWebhookRateLimitKey(ip: string): string {
  return `shopify-webhook:${String(ip || 'unknown').trim() || 'unknown'}`;
}

// ── L7: was the triggered catalog resync a failure/partial? ─────────────────
// syncShopifyCatalog returns a report[] and never throws for a PARTIAL fetch
// (it returns a "catalog fetch failed on page N — partial" line). The TRUNCATED
// page-cap case already fires its own loud signal from inside the sync, so it is
// deliberately NOT matched here (avoids a duplicate alert). A hard throw is
// handled separately by the route's catch — this only classifies a returned
// report.
export function catalogSyncReportIndicatesFailure(report: string[] | undefined | null): boolean {
  if (!Array.isArray(report)) return false;
  return report.some((line) => /fail|partial/i.test(String(line || '')));
}

// ── L8: fulfillment stamp patch (create fills, update overwrites) ────────────
export interface FulfillmentStampPatch {
  'Tracking Number'?: string;
  'Status'?: string;
  'Shipped At'?: string;
}

/**
 * The Airtable patch to stamp on a matched Rancher Orders row for a fulfillment
 * webhook, or an empty object for a no-op.
 *
 *  • fulfillments/create: set Tracking Number only when the row's is empty
 *    (unchanged legacy behavior — the first fulfillment writes it).
 *  • fulfillments/update: OVERWRITE Tracking Number with the freshest non-empty
 *    payload value (L8: a rancher who corrects the tracking in Shopify must
 *    propagate). Only emitted when it actually differs, so a redelivered
 *    identical update is still a no-op.
 *  • Status: a 'New' order flips to 'Shipped' + stamps Shipped At (unchanged),
 *    which is what stops the SLA chase.
 */
export function resolveFulfillmentStampPatch(args: {
  topic: string;
  incomingTracking: string;
  currentTracking: unknown;
  currentStatus: unknown;
  nowIso: string;
}): FulfillmentStampPatch {
  const { topic, incomingTracking, currentTracking, currentStatus, nowIso } = args;
  const patch: FulfillmentStampPatch = {};

  const incoming = String(incomingTracking || '').trim();
  const current = String(currentTracking ?? '').trim();
  if (incoming) {
    if (topic === 'fulfillments/update') {
      if (incoming !== current) patch['Tracking Number'] = incoming; // overwrite corrected tracking
    } else if (!current) {
      patch['Tracking Number'] = incoming; // create: fill only when empty
    }
  }

  if (String(currentStatus ?? '') === 'New') {
    patch['Status'] = 'Shipped';
    patch['Shipped At'] = nowIso;
  }

  return patch;
}
