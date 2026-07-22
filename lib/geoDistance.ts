// lib/geoDistance.ts
//
// Real-miles routing math (founder directive 2026-07-22: "local demand hot" —
// a buyer 20 miles from a rancher should route there, not to a same-state
// rancher 400 miles away).
//
// Layering — this file adds precision UNDERNEATH the existing gates, it never
// replaces them:
//   1. `Routing States` (admin-controlled) decides WHO is eligible at all.
//   2. lib/stateAdjacency.ts ranks eligible ranchers by state hops (coarse).
//   3. THIS FILE ranks by actual great-circle miles when both endpoints are
//      known, and falls back to `undecidable` (0) when either is missing so
//      the hop sort keeps governing. No buyer ZIP / no rancher lat-lng ⇒
//      byte-for-byte today's behavior.
//
// Pure math + coercion. No imports, no I/O — every branch is unit-tested.

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Mean Earth radius in statute miles (IUGG mean radius 6371.0088 km). */
const EARTH_RADIUS_MILES = 3958.7613;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in statute miles.
 *
 * Haversine (not the law of cosines) because we care about SHORT distances —
 * the cosine formula loses precision under ~1 mile, which is exactly the
 * "rancher down the road" case this feature exists for.
 */
export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  // Clamp: float drift can push `a` a hair past 1 for antipodal points, and
  // Math.sqrt of a negative would yield NaN → a rancher sorted to nowhere.
  const clamped = Math.min(1, Math.max(0, a));
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(clamped));
}

/**
 * Coerce a pair of Airtable number fields into a usable point.
 *
 * Returns null (never a guess) when either value is missing, non-numeric, or
 * out of range — and for the 0,0 sentinel, which is what an un-geocoded row
 * reads back as. Treating 0,0 as real would place a rancher in the Gulf of
 * Guinea and blow up every distance comparison they're in.
 */
export function toGeoPoint(lat: unknown, lng: unknown): GeoPoint | null {
  if (lat === null || lat === undefined || lat === '') return null;
  if (lng === null || lng === undefined || lng === '') return null;
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  if (la === 0 && ln === 0) return null;
  return { lat: la, lng: ln };
}

/** Miles between two optional points — null when either is unknown. */
export function distanceBetween(a: GeoPoint | null, b: GeoPoint | null): number | null {
  if (!a || !b) return null;
  return haversineMiles(a.lat, a.lng, b.lat, b.lng);
}

/**
 * Sort fragment: nearer first, UNDECIDABLE (0) when either distance is unknown.
 *
 * Returning 0 rather than sinking the unknown side is the backward-compat
 * contract: a rancher with no coordinates must not be reordered by a signal we
 * don't have. The caller falls through to `hopDistance`, i.e. today's sort.
 *
 * (Consequence, deliberate: with a MIXED pool — some ranchers geocoded, some
 * not — the comparator is not a strict total order. It never throws and never
 * loses a candidate; the ordering among unmeasurable pairs is just the old
 * hop/load-balance one. All 11 currently-active ranchers are geocoded, so the
 * mixed case is the rare path, not the common one.)
 */
export function distanceCmp(a: number | null, b: number | null): number {
  if (a === null || b === null) return 0;
  if (a === b) return 0;
  return a - b;
}

/** `Delivery Radius Miles` → positive miles, or null when unset/garbage. */
export function parseRadiusMiles(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * True only when `Local Delivery` is the rancher's SOLE fulfillment option.
 *
 * This is the whole reason the radius gate is safe. `Delivery Radius Miles` is
 * collected by the setup wizard as a REQUIRED sub-field of the "Local
 * Delivery" checkbox — it answers "how far will you drive an order", not "how
 * far will you serve a buyer". A rancher who also offers Local Pickup or
 * Cold-Chain Shipping reaches buyers well past that radius, so gating on it
 * would silently strand their leads. Live example (2026-07-22): Champion
 * Valley Farm is delivery+pickup with a 200 mi radius and routes CO — a naive
 * gate would have waitlisted every Denver buyer, with no other CO supply.
 *
 * Unset ⇒ false. A blank field never proves delivery-only (hard rule 1).
 */
export function isDeliveryOnly(fulfillmentTypes: unknown): boolean {
  const list = Array.isArray(fulfillmentTypes)
    ? fulfillmentTypes
    : typeof fulfillmentTypes === 'string'
      ? fulfillmentTypes.split(',')
      : [];
  const types = list
    .map((t) => String(t || '').trim().toLowerCase())
    .filter(Boolean);
  if (types.length === 0) return false;
  return types.every((t) => t === 'local delivery');
}

/**
 * The subset of an Airtable Ranchers row this module reads. Loose on purpose —
 * the routing engine passes whole rows through.
 */
export interface RancherGeoRow {
  Latitude?: unknown;
  Longitude?: unknown;
  'Delivery Radius Miles'?: unknown;
  'Fulfillment Types'?: unknown;
}

/**
 * Buyer→rancher miles for an Airtable rancher row, or null when either end is
 * unknown. Null is the whole backward-compat story: no buyer ZIP (every
 * consumer row before the funnel captured one) or an un-geocoded rancher means
 * every distance comparison below is a no-op.
 */
export function rancherDistanceMiles(
  buyerPoint: GeoPoint | null,
  rancher: RancherGeoRow | null | undefined,
): number | null {
  if (!buyerPoint || !rancher) return null;
  return distanceBetween(buyerPoint, toGeoPoint(rancher.Latitude, rancher.Longitude));
}

export type RadiusVerdict = 'no-gate' | 'within' | 'outside';

/**
 * Can this rancher actually serve this buyer, per their own delivery radius?
 *
 * `no-gate` (the fail-open default) whenever we lack the standing to judge:
 * no radius set, no measurable distance, or a rancher who isn't delivery-only.
 * Only a delivery-only rancher with a real radius AND a measured distance can
 * come back `outside`.
 */
export function evaluateDeliveryRadius(input: {
  distanceMiles: number | null;
  radiusMiles: unknown;
  fulfillmentTypes: unknown;
}): RadiusVerdict {
  const radius = parseRadiusMiles(input.radiusMiles);
  if (radius === null) return 'no-gate';
  if (input.distanceMiles === null) return 'no-gate';
  if (!isDeliveryOnly(input.fulfillmentTypes)) return 'no-gate';
  return input.distanceMiles <= radius ? 'within' : 'outside';
}

/**
 * Row-level convenience the routing engine calls: is this rancher's own
 * delivery radius unable to reach this buyer?
 *
 * False whenever we can't tell (no buyer point, no radius, not delivery-only)
 * — the gate only ever fires on positive evidence.
 */
export function isOutOfDeliveryRadius(
  buyerPoint: GeoPoint | null,
  rancher: RancherGeoRow | null | undefined,
): boolean {
  if (!rancher) return false;
  return (
    evaluateDeliveryRadius({
      distanceMiles: rancherDistanceMiles(buyerPoint, rancher),
      radiusMiles: rancher['Delivery Radius Miles'],
      fulfillmentTypes: rancher['Fulfillment Types'],
    }) === 'outside'
  );
}
