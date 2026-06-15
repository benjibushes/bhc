// lib/calBooking.ts
//
// SINGLE SOURCE OF TRUTH for the operator (Ben's) "book a call" link.
//
// INCIDENT (2026-06-14): every "book a call" link in the system was a
// hardcoded cal.com slug (/15min, /sales, /30min). Those Cal events were
// DELETED, so 41 ranchers got a dead 404 booking link and buyers couldn't
// book. This module replaces every hardcoded slug with an API-driven
// resolver that fetches the operator's LIVE event via the existing
// CAL_API_KEY (Ben's personal key, already set in prod env).
//
// Design rules:
//   - NEVER throws. A booking-link resolver that can throw is worse than the
//     bug it fixes — it would take down every email send that links to Cal.
//   - NEVER returns a cal.com slug that could 404. If we can't confirm a
//     live event, we return a real, always-200 page (/contact) instead.
//   - Dependency-light: just fetch + env. No SDK, no Airtable.
//   - Module-level cache (1h TTL). Resets per cold start — totally fine; the
//     point is to avoid hammering Cal on every email in a cron batch.
//
// Cal API pattern copied from app/api/admin/cal/bookings/route.ts:
//   Base:    https://api.cal.com/v2
//   Auth:    Authorization: Bearer ${CAL_API_KEY}
//   Version: cal-api-version: 2024-08-13

const CAL_API_BASE = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-08-13';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

// The always-200 fallback. /contact is a real page (never 404s) so a dead
// booking link can never ship to a rancher or buyer.
const FALLBACK_URL = `${SITE_URL}/contact`;

// 1h cache TTL. A booking slug effectively never changes hour-to-hour; this
// just keeps a cron batch (e.g. 41 reactivation emails) from making 41 pairs
// of Cal API calls.
const CACHE_TTL_MS = 60 * 60 * 1000;

interface BookingResolution {
  live: boolean;
  url: string;
  username?: string;
  eventCount: number;
}

// Module-level cache. Holds the FULL resolution (so getOperatorBookingStatus
// and getOperatorBookingUrl share one fetch). Only successful LIVE resolutions
// are cached — a fallback result is never cached, so a transient Cal outage
// doesn't pin us to /contact for an hour.
let _cache: { value: BookingResolution; at: number } | null = null;

function readFromHeaders() {
  return {
    Authorization: `Bearer ${process.env.CAL_API_KEY}`,
    'cal-api-version': CAL_API_VERSION,
  };
}

/**
 * Normalize the many shapes Cal's /event-types endpoint can return into a
 * flat array of event-type objects. Observed shapes:
 *   - { data: [ {…}, … ] }
 *   - { data: { eventTypeGroups: [ { eventTypes: [ {…} ] } ] } }
 *   - { event_types: [ {…} ] }   (snake_case variant)
 */
function extractEventTypes(json: any): any[] {
  if (!json) return [];
  const data = json.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.eventTypeGroups)) {
    const out: any[] = [];
    for (const group of data.eventTypeGroups) {
      if (group && Array.isArray(group.eventTypes)) out.push(...group.eventTypes);
    }
    return out;
  }
  if (Array.isArray(json.event_types)) return json.event_types;
  // Last-ditch: some shapes nest the array one deeper under data.eventTypes.
  if (data && Array.isArray(data.eventTypes)) return data.eventTypes;
  return [];
}

/**
 * Pull the operator's Cal username from GET /me. Tolerates the wrapper shapes
 * ({ data: { username } } / { data: { user: { username } } } / { username }).
 * Returns '' on any failure (caller treats empty as "can't resolve").
 */
function extractUsername(json: any): string {
  const d = json?.data ?? json;
  const user = d?.user ?? d;
  return String(user?.username || '').trim();
}

/**
 * Do the live Cal lookup. Returns a full resolution. NEVER throws — any error
 * resolves to the /contact fallback (live:false) so callers can treat the
 * result uniformly. Logs a single warn on the fallback path so the operator
 * can see it in Vercel logs.
 */
async function resolveLive(): Promise<BookingResolution> {
  const apiKey = process.env.CAL_API_KEY || '';
  if (!apiKey) {
    console.warn('[calBooking] no live Cal event — falling back to /contact');
    return { live: false, url: FALLBACK_URL, eventCount: 0 };
  }

  try {
    const meRes = await fetch(`${CAL_API_BASE}/me`, { headers: readFromHeaders() });
    if (!meRes.ok) {
      console.warn('[calBooking] no live Cal event — falling back to /contact');
      return { live: false, url: FALLBACK_URL, eventCount: 0 };
    }
    const meJson = await meRes.json();
    const username = extractUsername(meJson);
    if (!username) {
      console.warn('[calBooking] no live Cal event — falling back to /contact');
      return { live: false, url: FALLBACK_URL, eventCount: 0 };
    }

    const etRes = await fetch(`${CAL_API_BASE}/event-types`, { headers: readFromHeaders() });
    if (!etRes.ok) {
      console.warn('[calBooking] no live Cal event — falling back to /contact');
      return { live: false, url: FALLBACK_URL, username, eventCount: 0 };
    }
    const etJson = await etRes.json();
    const events = extractEventTypes(etJson);

    // First non-hidden event wins. hidden !== true tolerates undefined/missing.
    const liveEvent = events.find((e) => e && e.hidden !== true);
    const slug = String(liveEvent?.slug || '').trim();

    if (!liveEvent || !slug) {
      console.warn('[calBooking] no live Cal event — falling back to /contact');
      return { live: false, url: FALLBACK_URL, username, eventCount: events.length };
    }

    return {
      live: true,
      url: `https://cal.com/${username}/${slug}`,
      username,
      eventCount: events.length,
    };
  } catch {
    console.warn('[calBooking] no live Cal event — falling back to /contact');
    return { live: false, url: FALLBACK_URL, eventCount: 0 };
  }
}

/**
 * Resolve the operator's live booking URL, using the module cache. Only LIVE
 * resolutions are cached; fallbacks are always re-attempted on the next call.
 */
async function resolve(): Promise<BookingResolution> {
  // Manual override always wins, bypasses cache + Cal entirely.
  const override = (process.env.CAL_BOOKING_URL || '').trim();
  if (override) {
    return { live: true, url: override, eventCount: 1 };
  }

  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) {
    return _cache.value;
  }

  const result = await resolveLive();
  if (result.live) {
    _cache = { value: result, at: Date.now() };
  }
  return result;
}

/**
 * SINGLE SOURCE OF TRUTH for Ben's booking link.
 *
 * Resolution order (never throws, never returns a 404-able cal.com slug):
 *   1. CAL_BOOKING_URL env (manual override) → return as-is.
 *   2. Live Cal API lookup (cached 1h): GET /me → username, GET /event-types
 *      → first non-hidden event → https://cal.com/<username>/<slug>.
 *   3. Any error / no live event / no CAL_API_KEY → SITE_URL/contact.
 */
export async function getOperatorBookingUrl(): Promise<string> {
  const r = await resolve();
  return r.url;
}

/**
 * Diagnostics + guard surface. Lets callers (e.g. the dead-link guard in
 * lib/email.ts, or an admin endpoint) see whether the link is live without
 * re-implementing the resolution logic.
 */
export async function getOperatorBookingStatus(): Promise<{
  live: boolean;
  url: string;
  username?: string;
  eventCount: number;
}> {
  return resolve();
}

// Exported only so the dead-link guard can compare a resolved URL against the
// fallback without hardcoding the string in two places.
export const OPERATOR_BOOKING_FALLBACK_URL = FALLBACK_URL;
