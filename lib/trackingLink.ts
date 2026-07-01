// lib/trackingLink.ts
//
// D3 (2026-07-01) — pure helper: turn the rancher-typed carrier + tracking
// number (free-text fields on the Referral, see lib/fulfillmentTracking
// FULFILLMENT_FIELDS) into a buyer-clickable tracking URL.
//
// Used by BOTH the /member order card and the "your beef is on the way"
// email, so it must be import-clean: no Airtable, no env, no next/server.
//
// Contract:
//   - UPS / FedEx / USPS → the carrier's own tracking URL.
//   - Carrier match is case-insensitive contains (punctuation ignored), so
//     "UPS Ground", "FedEx Home Delivery", "U.S.P.S." all resolve.
//   - Anything else (regional couriers, typos) → a Google
//     "<carrier> tracking <number>" search URL — always useful, never wrong.
//   - Empty or garbage tracking number → null. Callers render NOTHING on
//     null; a broken link is worse than no link.

const MIN_TRACKING_LEN = 6;
const MAX_TRACKING_LEN = 60;

// After stripping internal whitespace, real tracking numbers are plain
// alphanumeric (occasionally hyphenated). Anything outside that is garbage —
// or worse, an injection attempt — so we refuse to build a URL from it.
const TRACKING_SHAPE = /^[A-Za-z0-9-]+$/;

/**
 * Build a tracking URL for a carrier + tracking number, or null when the
 * tracking number is unusable. Pure, side-effect free.
 */
export function carrierTrackingUrl(carrier: unknown, trackingNumber: unknown): string | null {
  if (typeof trackingNumber !== 'string') return null;

  // Normalize: ranchers paste numbers with spaces ("9400 1118 ..."); carriers
  // don't want them.
  const tracking = trackingNumber.trim().replace(/\s+/g, '');
  if (
    tracking.length < MIN_TRACKING_LEN ||
    tracking.length > MAX_TRACKING_LEN ||
    !TRACKING_SHAPE.test(tracking)
  ) {
    return null;
  }

  const carrierRaw = typeof carrier === 'string' ? carrier.trim() : '';
  // Compact form for matching only: lowercase, letters only — so "U.S.P.S."
  // and "FedEx Home Delivery" both match. Check usps BEFORE ups.
  const compact = carrierRaw.toLowerCase().replace(/[^a-z]/g, '');

  const encoded = encodeURIComponent(tracking);
  if (compact.includes('usps')) {
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encoded}`;
  }
  if (compact.includes('ups')) {
    return `https://www.ups.com/track?tracknum=${encoded}`;
  }
  if (compact.includes('fedex')) {
    return `https://www.fedex.com/fedextrack/?trknbr=${encoded}`;
  }

  // Unknown (or missing) carrier: a Google search always gets the buyer
  // somewhere useful — most carriers' tracking pages are the first result.
  const query = carrierRaw ? `${carrierRaw} tracking ${tracking}` : `tracking ${tracking}`;
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}
