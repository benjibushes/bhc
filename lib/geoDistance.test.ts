// lib/geoDistance.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineMiles,
  toGeoPoint,
  distanceBetween,
  distanceCmp,
  parseRadiusMiles,
  isDeliveryOnly,
  evaluateDeliveryRadius,
  rancherDistanceMiles,
  isOutOfDeliveryRadius,
} from './geoDistance';

// ── haversineMiles: known distances ─────────────────────────────────────────

test('haversineMiles: identical points are zero', () => {
  assert.equal(haversineMiles(40.7484, -73.9967, 40.7484, -73.9967), 0);
});

test('haversineMiles: one degree of latitude ≈ 69.09 miles', () => {
  const d = haversineMiles(0, 0, 1, 0);
  assert.ok(Math.abs(d - 69.09) < 0.2, `expected ~69.09, got ${d}`);
});

test('haversineMiles: one degree of longitude at the equator ≈ 69.09 miles', () => {
  const d = haversineMiles(0, 0, 0, 1);
  assert.ok(Math.abs(d - 69.09) < 0.2, `expected ~69.09, got ${d}`);
});

test('haversineMiles: one degree of longitude at 60°N is half the equator value', () => {
  const d = haversineMiles(60, 0, 60, 1);
  assert.ok(Math.abs(d - 34.5) < 0.3, `expected ~34.5, got ${d}`);
});

test('haversineMiles: NYC → LA ≈ 2451 miles (published great-circle)', () => {
  const d = haversineMiles(40.7128, -74.006, 34.0522, -118.2437);
  assert.ok(Math.abs(d - 2451) < 15, `expected ~2451, got ${d}`);
});

test('haversineMiles: Austin → Houston ≈ 146 miles (published great-circle)', () => {
  const d = haversineMiles(30.271, -97.743, 29.76, -95.369);
  assert.ok(Math.abs(d - 146) < 5, `expected ~146, got ${d}`);
});

test('haversineMiles: is symmetric', () => {
  const ab = haversineMiles(36.016, -96.509, 29.76, -95.369);
  const ba = haversineMiles(29.76, -95.369, 36.016, -96.509);
  assert.equal(ab, ba);
});

test('haversineMiles: antipodal points do not NaN on float drift', () => {
  const d = haversineMiles(0, 0, 0, 180);
  assert.ok(Number.isFinite(d), `expected finite, got ${d}`);
  assert.ok(Math.abs(d - 12437) < 40, `expected ~12437 (half circumference), got ${d}`);
});

// ── toGeoPoint: Airtable field coercion ─────────────────────────────────────

test('toGeoPoint: accepts numbers and numeric strings', () => {
  assert.deepEqual(toGeoPoint(40.5, -97.2), { lat: 40.5, lng: -97.2 });
  assert.deepEqual(toGeoPoint('40.5', '-97.2'), { lat: 40.5, lng: -97.2 });
});

test('toGeoPoint: rejects missing, blank, NaN and out-of-range values', () => {
  assert.equal(toGeoPoint(undefined, undefined), null);
  assert.equal(toGeoPoint(null, null), null);
  assert.equal(toGeoPoint('', ''), null);
  assert.equal(toGeoPoint(40.5, undefined), null);
  assert.equal(toGeoPoint('abc', '-97.2'), null);
  assert.equal(toGeoPoint(91, 0), null, 'latitude > 90');
  assert.equal(toGeoPoint(0, 181), null, 'longitude > 180');
});

test('toGeoPoint: rejects the 0,0 null-island sentinel', () => {
  // An un-geocoded Airtable row reads back as 0/0, which would otherwise be
  // treated as a real point in the Gulf of Guinea and rank absurdly far.
  assert.equal(toGeoPoint(0, 0), null);
});

// ── distanceBetween: missing-data fallbacks ─────────────────────────────────

test('distanceBetween: null when either point is missing', () => {
  const p = { lat: 40, lng: -97 };
  assert.equal(distanceBetween(null, p), null);
  assert.equal(distanceBetween(p, null), null);
  assert.equal(distanceBetween(null, null), null);
});

test('distanceBetween: miles when both points are present', () => {
  const d = distanceBetween({ lat: 30.271, lng: -97.743 }, { lat: 29.76, lng: -95.369 });
  assert.ok(d !== null && Math.abs(d - 146) < 5, `expected ~146, got ${d}`);
});

// ── distanceCmp: the sort fragment ──────────────────────────────────────────

test('distanceCmp: nearer wins', () => {
  assert.ok(distanceCmp(10, 200) < 0);
  assert.ok(distanceCmp(200, 10) > 0);
});

test('distanceCmp: equal distances tie', () => {
  assert.equal(distanceCmp(42, 42), 0);
});

test('distanceCmp: UNDECIDABLE (0) when either side is unknown', () => {
  // This is the backward-compat contract: a rancher with no Latitude/Longitude
  // must never be reordered by distance — the caller falls through to the
  // existing hopDistance tiebreak, i.e. exactly today's behavior.
  assert.equal(distanceCmp(null, 10), 0);
  assert.equal(distanceCmp(10, null), 0);
  assert.equal(distanceCmp(null, null), 0);
});

// ── parseRadiusMiles ────────────────────────────────────────────────────────

test('parseRadiusMiles: reads positive numbers and numeric strings', () => {
  assert.equal(parseRadiusMiles(200), 200);
  assert.equal(parseRadiusMiles('200'), 200);
});

test('parseRadiusMiles: null for unset / zero / negative / garbage', () => {
  assert.equal(parseRadiusMiles(undefined), null);
  assert.equal(parseRadiusMiles(null), null);
  assert.equal(parseRadiusMiles(''), null);
  assert.equal(parseRadiusMiles(0), null);
  assert.equal(parseRadiusMiles(-5), null);
  assert.equal(parseRadiusMiles('abc'), null);
});

// ── isDeliveryOnly ──────────────────────────────────────────────────────────

test('isDeliveryOnly: true only when Local Delivery is the sole fulfillment type', () => {
  assert.equal(isDeliveryOnly(['Local Delivery']), true);
  assert.equal(isDeliveryOnly(['Local Delivery', 'Local Pickup']), false);
  assert.equal(isDeliveryOnly(['Local Delivery', 'Cold-Chain Shipping']), false);
  assert.equal(isDeliveryOnly(['Cold-Chain Shipping']), false);
});

test('isDeliveryOnly: false when unset — an empty field never proves delivery-only', () => {
  assert.equal(isDeliveryOnly(undefined), false);
  assert.equal(isDeliveryOnly(null), false);
  assert.equal(isDeliveryOnly([]), false);
});

test('isDeliveryOnly: tolerates a comma string instead of a multi-select array', () => {
  assert.equal(isDeliveryOnly('Local Delivery'), true);
  assert.equal(isDeliveryOnly('Local Delivery, Local Pickup'), false);
});

// ── evaluateDeliveryRadius: the gate ────────────────────────────────────────

test('evaluateDeliveryRadius: no-gate when the rancher set no radius', () => {
  assert.equal(
    evaluateDeliveryRadius({ distanceMiles: 900, radiusMiles: null, fulfillmentTypes: ['Local Delivery'] }),
    'no-gate',
  );
});

test('evaluateDeliveryRadius: no-gate when distance is unknown', () => {
  // Buyer has no usable ZIP (or rancher has no lat/lng) → we cannot measure,
  // so we must not drop anyone. This is the no-ZIP backward-compat path.
  assert.equal(
    evaluateDeliveryRadius({ distanceMiles: null, radiusMiles: 200, fulfillmentTypes: ['Local Delivery'] }),
    'no-gate',
  );
});

test('evaluateDeliveryRadius: no-gate when the rancher also pickups or ships', () => {
  // Delivery Radius Miles is bound to the "Local Delivery" fulfillment option
  // in the setup wizard — it is NOT a statement about how far the rancher will
  // serve. A rancher who also offers pickup or cold-chain shipping can serve
  // far buyers, so their delivery radius must not gate routing.
  assert.equal(
    evaluateDeliveryRadius({ distanceMiles: 900, radiusMiles: 200, fulfillmentTypes: ['Local Delivery', 'Local Pickup'] }),
    'no-gate',
  );
  assert.equal(
    evaluateDeliveryRadius({ distanceMiles: 900, radiusMiles: 200, fulfillmentTypes: ['Local Delivery', 'Cold-Chain Shipping'] }),
    'no-gate',
  );
});

test('evaluateDeliveryRadius: within / outside for a delivery-only rancher', () => {
  const base = { radiusMiles: 200, fulfillmentTypes: ['Local Delivery'] };
  assert.equal(evaluateDeliveryRadius({ ...base, distanceMiles: 10 }), 'within');
  assert.equal(evaluateDeliveryRadius({ ...base, distanceMiles: 200 }), 'within', 'boundary is inclusive');
  assert.equal(evaluateDeliveryRadius({ ...base, distanceMiles: 200.5 }), 'outside');
  assert.equal(evaluateDeliveryRadius({ ...base, distanceMiles: 435 }), 'outside');
});

// ── Row-level helpers, against the LIVE rancher shapes (probed 2026-07-22) ──

/** Gift Farms LLC (OK) — delivery-ONLY, 200 mi radius. */
const GIFT_FARMS = {
  Latitude: 36.016006164062546,
  Longitude: -96.50938579316939,
  'Delivery Radius Miles': 200,
  'Fulfillment Types': ['Local Delivery'],
};
/** Champion Valley Farm (NE) — delivery + PICKUP, 200 mi radius. */
const CHAMPION_VALLEY = {
  Latitude: 40.86769175223186,
  Longitude: -97.96232148790385,
  'Delivery Radius Miles': 200,
  'Fulfillment Types': ['Local Delivery', 'Local Pickup'],
};
/** Lazy Bar 3 (TX) — no radius, no fulfillment types recorded. */
const LAZY_BAR_3 = { Latitude: 31.969, Longitude: -99.901 };
/** A rancher who was never geocoded. */
const UNGEOCODED = { 'Delivery Radius Miles': 200, 'Fulfillment Types': ['Local Delivery'] };

const TULSA = { lat: 36.154, lng: -95.993 };
const HOUSTON = { lat: 29.76, lng: -95.369 };
const DENVER = { lat: 39.739, lng: -104.985 };

test('rancherDistanceMiles: measures a real buyer→rancher pair', () => {
  const d = rancherDistanceMiles(TULSA, GIFT_FARMS);
  assert.ok(d !== null && d < 40, `Tulsa → Gift Farms should be a short hop, got ${d}`);
});

test('rancherDistanceMiles: null when the buyer has no resolvable ZIP', () => {
  // THE backward-compat path: 2,745 of 2,745 consumer rows had no Zip on
  // 2026-07-22, so this is the branch every existing buyer takes.
  assert.equal(rancherDistanceMiles(null, GIFT_FARMS), null);
});

test('rancherDistanceMiles: null when the rancher was never geocoded', () => {
  assert.equal(rancherDistanceMiles(TULSA, UNGEOCODED), null);
  assert.equal(rancherDistanceMiles(TULSA, null), null);
});

test('BACKWARD COMPAT: with no buyer point, distance never reorders anyone', () => {
  // Every pairing of the live roster must compare as UNDECIDABLE so the
  // caller's hopDistance sort keeps governing — i.e. byte-for-byte today's
  // routing for a buyer without a ZIP.
  const roster = [GIFT_FARMS, CHAMPION_VALLEY, LAZY_BAR_3, UNGEOCODED];
  for (const a of roster) {
    for (const b of roster) {
      assert.equal(
        distanceCmp(rancherDistanceMiles(null, a), rancherDistanceMiles(null, b)),
        0,
        'no buyer ZIP must never produce a distance preference',
      );
    }
  }
});

test('BACKWARD COMPAT: with no buyer point, the radius gate never fires', () => {
  for (const r of [GIFT_FARMS, CHAMPION_VALLEY, LAZY_BAR_3, UNGEOCODED]) {
    assert.equal(isOutOfDeliveryRadius(null, r), false);
  }
});

test('BACKWARD COMPAT: an un-geocoded rancher is never radius-gated', () => {
  assert.equal(isOutOfDeliveryRadius(TULSA, UNGEOCODED), false);
});

test('isOutOfDeliveryRadius: delivery-only rancher gates a far buyer', () => {
  // Gift Farms delivers only, 200 mi. Tulsa is next door; Houston is ~435 mi
  // away and in a state they route (TX) — exactly the lead that dead-ends.
  assert.equal(isOutOfDeliveryRadius(TULSA, GIFT_FARMS), false);
  assert.equal(isOutOfDeliveryRadius(HOUSTON, GIFT_FARMS), true);
});

test('isOutOfDeliveryRadius: a rancher who also offers pickup is NEVER gated', () => {
  // Champion Valley routes CO and is ~380 mi from Denver — past their delivery
  // radius, but they offer Local Pickup and there is no other CO supply. A
  // naive radius gate would have waitlisted every Denver buyer.
  const miles = rancherDistanceMiles(DENVER, CHAMPION_VALLEY);
  assert.ok(miles !== null && miles > 200, `expected Denver > 200 mi, got ${miles}`);
  assert.equal(isOutOfDeliveryRadius(DENVER, CHAMPION_VALLEY), false);
});

test('nearest-first: the whole point of the feature', () => {
  // A Tulsa buyer ranked across the live roster puts Gift Farms first, ahead
  // of ranchers that state-granularity alone would have tied or preferred.
  const ranked = [LAZY_BAR_3, CHAMPION_VALLEY, GIFT_FARMS]
    .map((r) => ({ r, d: rancherDistanceMiles(TULSA, r) }))
    .sort((a, b) => distanceCmp(a.d, b.d));
  assert.equal(ranked[0].r, GIFT_FARMS);
});
