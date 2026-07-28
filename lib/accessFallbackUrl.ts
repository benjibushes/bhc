// lib/accessFallbackUrl.ts
//
// K1 (conversion audit 2026-07-28) — ONE builder for every "this ranch can't
// serve you here → go take the quiz" redirect.
//
// The reserve/order forms used to silently teleport buyers to a pristine
// /access quiz: their typed input vanished and nothing explained why. Every
// fallback redirect now carries an ?error= key that app/access/page.tsx maps
// to a NOTICES banner, so the buyer gets one honest line of context.
//
// Copy rule (exclusivity): the banner copy NEVER names ZIPs or territories —
// "doesn't deliver to your area" is as specific as it gets.

/**
 * Why the buyer is being handed to the quiz:
 * - 'out_of_area'      — the ranch is contracted to a service area that does
 *                        not cover them. Never re-pin the declining ranch.
 * - 'reserve_fallback' — the ranch can't take this request right now
 *                        (ineligible for instant deposits, paused, or a
 *                        transient 5xx on the fast path).
 */
export type AccessFallbackError = 'out_of_area' | 'reserve_fallback';

export function accessFallbackUrl(error: AccessFallbackError, rancherSlug?: string): string {
  const params = new URLSearchParams();
  // rancher first — matches the hand-built `/access?rancher=<slug>` links
  // elsewhere, so the URL shape stays familiar in logs/analytics.
  if (rancherSlug) params.set('rancher', rancherSlug);
  params.set('error', error);
  return `/access?${params.toString()}`;
}
