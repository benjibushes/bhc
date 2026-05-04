// ZIP-first geocoding lib for rancher map pins.
//
// Why ZIP-first: city + state geocoding lands at city centroid — multiple
// ranchers in same city stack at one pin, and centroid can be 10+ miles
// from the actual property. ZIP centroid is much tighter (~3-5 mile
// radius typical), still privacy-preserving (no street address).
//
// Provider stack:
//   1. zippopotam.us — free, no rate limit, no auth, purpose-built for
//      ZIP→lat/lng. Primary path when ZIP provided.
//   2. Nominatim (OSM) — fallback for city+state when no ZIP, OR when
//      zippopotam is down. Adds &countrycodes=us to prevent foreign
//      matches.
//   3. Reverse Nominatim — used by the backfill script to derive ZIP
//      from existing lat/lng for legacy ranchers.
//
// Always returns null on failure — caller decides whether to skip the
// pin or use a fallback.

import { NOMINATIM_USER_AGENT } from '@/lib/secrets';

export interface GeocodeResult {
  lat: number;
  lng: number;
  /** "zip" | "city-state" | "reverse" — tells caller how precise the result is */
  source: 'zip' | 'city-state' | 'reverse';
  /** ZIP returned by zippopotam (when source='zip'), or by reverse-geocode */
  zip?: string;
  city?: string;
  state?: string;
}

/** zippopotam.us — primary geocoder when ZIP is known. ~50ms typical. */
async function geocodeByZip(zip: string): Promise<GeocodeResult | null> {
  const clean = zip.trim().slice(0, 5);
  if (!/^\d{5}$/.test(clean)) return null;
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${clean}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const place = data?.places?.[0];
    const lat = parseFloat(place?.latitude || '');
    const lng = parseFloat(place?.longitude || '');
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return {
      lat,
      lng,
      source: 'zip',
      zip: clean,
      city: place['place name'] || undefined,
      state: place['state abbreviation'] || undefined,
    };
  } catch {
    return null;
  }
}

/** Nominatim — fallback for city + state when no ZIP. Forward geocode. */
async function geocodeByCityState(
  city: string,
  state: string
): Promise<GeocodeResult | null> {
  const c = city.trim();
  const s = state.trim();
  if (!c && !s) return null;
  const q = c ? `${c}, ${s}, USA` : `${s}, USA`;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_USER_AGENT },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return { lat, lng, source: 'city-state', city: c, state: s };
  } catch {
    return null;
  }
}

/** Reverse geocode lat/lng → ZIP. Used by backfill to harvest ZIPs for legacy ranchers. */
export async function reverseGeocodeToZip(
  lat: number,
  lng: number
): Promise<{ zip?: string; city?: string; state?: string } | null> {
  if (!isFinite(lat) || !isFinite(lng)) return null;
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_USER_AGENT },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const a = data?.address || {};
    return {
      zip: (a.postcode || '').toString().slice(0, 5) || undefined,
      city:
        a.city ||
        a.town ||
        a.village ||
        a.hamlet ||
        a.county ||
        undefined,
      state: a.state_code || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Top-level geocode. Tries ZIP first, falls back to city+state. Caller
 * provides whichever it has — most accurate path is auto-selected.
 *
 * Privacy note: even with ZIP, pin lands at ZIP centroid, NOT the
 * rancher's home/property. ~3-5 mile typical centroid offset. Don't
 * pass street addresses through here — that defeats the privacy
 * guarantee.
 */
export async function geocodeRancher(input: {
  zip?: string;
  city?: string;
  state?: string;
}): Promise<GeocodeResult | null> {
  if (input.zip) {
    const r = await geocodeByZip(input.zip);
    if (r) return r;
  }
  if (input.city || input.state) {
    return geocodeByCityState(input.city || '', input.state || '');
  }
  return null;
}
