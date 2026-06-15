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
// Cal's event-types endpoints require a DIFFERENT api version than /me + /bookings.
// With 2024-08-13, GET /v2/event-types 404s ("Cannot GET /v2/event-types"); the
// correct version per Cal docs is 2024-06-14. (Incident 2026-06-15.)
const CAL_EVENT_TYPES_VERSION = '2024-06-14';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

// The always-200 fallback. /contact is a real page (never 404s) so a dead
// booking link can never ship to a rancher or buyer.
const FALLBACK_URL = `${SITE_URL}/contact`;

// 1h cache TTL. A booking slug effectively never changes hour-to-hour; this
// just keeps a cron batch (e.g. 41 reactivation emails) from making 41 pairs
// of Cal API calls.
const CACHE_TTL_MS = 60 * 60 * 1000;

// Which Cal event a caller wants. Ben runs MULTIPLE live events serving
// different audiences:
//   - 'sales'   → "Sales Calls" (slug `sales`, 15min) — BUYER sales calls.
//   - 'rancher' → "Rancher Onboarding" (slug `30min`, 45min) — rancher
//     migration/onboarding calls.
// Picking the FIRST non-hidden event (the old behavior) sent every caller to
// Sales Calls, so rancher migration emails linked buyers' sales slot. The
// `purpose` arg selects the right event from the fetched list.
export type BookingPurpose = 'rancher' | 'sales';

interface BookingResolution {
  live: boolean;
  url: string;
  username?: string;
  eventCount: number;
}

// Module-level cache, KEYED BY PURPOSE. Holds the FULL resolution (so
// getOperatorBookingStatus and getOperatorBookingUrl share one fetch). Only
// successful LIVE resolutions are cached — a fallback result is never cached,
// so a transient Cal outage doesn't pin us to /contact for an hour. Keyed so
// 'rancher' and 'sales' don't clobber each other (they resolve to different
// events).
const _cache = new Map<BookingPurpose, { value: BookingResolution; at: number }>();

function readFromHeaders(version: string = CAL_API_VERSION) {
  return {
    Authorization: `Bearer ${process.env.CAL_API_KEY}`,
    'cal-api-version': version,
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
 * Pick the right event for `purpose` from the non-hidden events list:
 *   - 'rancher': slug === '30min' OR title/slug includes 'rancher' / 'onboard'.
 *   - 'sales':   slug === 'sales'  OR title includes 'sales'.
 * Falls back to the first non-hidden event (the old behavior) when no
 * purpose-specific match exists, so a renamed event still resolves to a live
 * slot rather than /contact. Returns undefined only when there are no events.
 */
function selectEventForPurpose(events: any[], purpose: BookingPurpose): any | undefined {
  const nonHidden = events.filter((e) => e && e.hidden !== true);
  if (nonHidden.length === 0) return undefined;

  const match = nonHidden.find((e) => {
    const slug = String(e.slug || '').toLowerCase().trim();
    const title = String(e.title || '').toLowerCase().trim();
    if (purpose === 'rancher') {
      return slug === '30min' || slug.includes('rancher') || slug.includes('onboard')
        || title.includes('rancher') || title.includes('onboard');
    }
    // 'sales'
    return slug === 'sales' || title.includes('sales');
  });

  // Fall back to the first non-hidden event (current behavior) on no match.
  return match || nonHidden[0];
}

/**
 * Do the live Cal lookup for `purpose`. Returns a full resolution. NEVER throws
 * — any error resolves to the /contact fallback (live:false) so callers can
 * treat the result uniformly. Logs a single warn on the fallback path so the
 * operator can see it in Vercel logs.
 */
async function resolveLive(purpose: BookingPurpose): Promise<BookingResolution> {
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

    const etRes = await fetch(`${CAL_API_BASE}/event-types`, { headers: readFromHeaders(CAL_EVENT_TYPES_VERSION) });
    if (!etRes.ok) {
      console.warn('[calBooking] no live Cal event — falling back to /contact');
      return { live: false, url: FALLBACK_URL, username, eventCount: 0 };
    }
    const etJson = await etRes.json();
    const events = extractEventTypes(etJson);

    // Pick the event matching `purpose` (rancher onboarding vs buyer sales),
    // falling back to the first non-hidden event. hidden !== true tolerates
    // undefined/missing.
    const liveEvent = selectEventForPurpose(events, purpose);
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
 * The manual override URL for `purpose`, checked BEFORE the Cal API (same as
 * the old single CAL_BOOKING_URL). Purpose-specific var wins, then the shared
 * CAL_BOOKING_URL legacy var:
 *   - 'rancher' → CAL_RANCHER_BOOKING_URL || CAL_BOOKING_URL
 *   - 'sales'   → CAL_SALES_BOOKING_URL   || CAL_BOOKING_URL
 */
function overrideForPurpose(purpose: BookingPurpose): string {
  const specific =
    purpose === 'rancher' ? process.env.CAL_RANCHER_BOOKING_URL : process.env.CAL_SALES_BOOKING_URL;
  return (specific || process.env.CAL_BOOKING_URL || '').trim();
}

/**
 * Resolve the operator's live booking URL for `purpose`, using the per-purpose
 * module cache. Only LIVE resolutions are cached; fallbacks are always
 * re-attempted on the next call.
 */
async function resolve(purpose: BookingPurpose): Promise<BookingResolution> {
  // Manual override always wins, bypasses cache + Cal entirely.
  const override = overrideForPurpose(purpose);
  if (override) {
    return { live: true, url: override, eventCount: 1 };
  }

  const cached = _cache.get(purpose);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const result = await resolveLive(purpose);
  if (result.live) {
    _cache.set(purpose, { value: result, at: Date.now() });
  }
  return result;
}

/**
 * SINGLE SOURCE OF TRUTH for Ben's booking link.
 *
 * `purpose` selects which live Cal event to link (defaults to 'sales' so
 * existing buyer surfaces are unchanged):
 *   - 'sales'   → "Sales Calls" (buyer sales calls).
 *   - 'rancher' → "Rancher Onboarding" (rancher migration/onboarding calls).
 *
 * Resolution order (never throws, never returns a 404-able cal.com slug):
 *   1. Env override (manual): rancher → CAL_RANCHER_BOOKING_URL||CAL_BOOKING_URL;
 *      sales → CAL_SALES_BOOKING_URL||CAL_BOOKING_URL → return as-is.
 *   2. Live Cal API lookup (cached 1h, per purpose): GET /me → username,
 *      GET /event-types → purpose-matched non-hidden event (else first
 *      non-hidden) → https://cal.com/<username>/<slug>.
 *   3. Any error / no live event / no CAL_API_KEY → SITE_URL/contact.
 */
export async function getOperatorBookingUrl(purpose: BookingPurpose = 'sales'): Promise<string> {
  const r = await resolve(purpose);
  return r.url;
}

/**
 * Diagnostics + guard surface. Lets callers (e.g. the dead-link guard in
 * lib/email.ts, or an admin endpoint) see whether the link is live without
 * re-implementing the resolution logic. `purpose` mirrors getOperatorBookingUrl.
 */
export async function getOperatorBookingStatus(purpose: BookingPurpose = 'sales'): Promise<{
  live: boolean;
  url: string;
  username?: string;
  eventCount: number;
}> {
  return resolve(purpose);
}

// Exported only so the dead-link guard can compare a resolved URL against the
// fallback without hardcoding the string in two places.
export const OPERATOR_BOOKING_FALLBACK_URL = FALLBACK_URL;
