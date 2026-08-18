// lib/statsFallback.ts
//
// THE single source for the hardcoded public-stats fallback numbers — the
// absolute last resort shown only when /api/stats/public itself fails AND no
// stale cached copy exists (in-process, Redis, or ISR). Consumers:
//   • app/api/stats/public/route.ts  (last-ditch catch path)
//   • app/founders/page.tsx          (capital-raise page)
//   • app/wholesale/page.tsx         (hero stats)
//   • app/brand-partners/page.tsx    (scarcity counter)
//
// ── REFRESHED 2026-08-17 from live GET /api/stats/public ────────────────────
//   ranchersActive 12 · familiesMatched 2626 · states 10 · totalClosedWon 24
//   brandPartnersRemaining 100 (zero paid brand partners → full cap)
// Before this sweep the constants were frozen at the 2026-05 era values
// (17 / 1533 / 5 / 11) and duplicated per-page — a buyer or backer hitting an
// Airtable outage saw year-old numbers. When these drift stale again, refresh
// from the live endpoint and update the date above — never invent, and never
// add a per-page copy (lib/statsFallback.test.ts enforces single-sourcing).

import { FOUNDING_BRAND_PARTNER_CAP } from './tiers';

export const STATS_FALLBACK_REFRESHED = '2026-08-17';

export const STATS_FALLBACK = {
  ranchersActive: 12,
  familiesMatched: 2626,
  states: 10,
  totalClosedWon: 24,
  // Cap minus paid brand partners; none are paid yet, so the honest fallback
  // is the full cap — not a manufactured-scarcity "5 spots left".
  brandPartnersRemaining: FOUNDING_BRAND_PARTNER_CAP,
} as const;

/**
 * Pull required numeric fields out of a live /api/stats/public payload.
 *
 * Throws if any field is missing or non-numeric — callers treat that as a
 * FAILED fetch and fall back to STATS_FALLBACK wholesale. A real low number
 * from the API — including 0 — is returned untouched: fallbacks exist for
 * outages, never for overwriting true answers we'd rather not render. (The
 * old /founders coercion floors did exactly that: familiesMatched<=0 → 1533,
 * states<=0 → 5. Killed 2026-08-17.)
 *
 * The check is `typeof === 'number'`, not Number() coercion (#632 review
 * hardening): Number(null) is 0, so a corrupted cached payload carrying a
 * null field rendered a fake zero instead of tripping the fallback. Only a
 * genuine finite JSON number passes.
 */
export function requireLiveStats<K extends string>(
  json: unknown,
  fields: readonly K[]
): Record<K, number> {
  const bag = (json ?? {}) as Record<string, unknown>;
  const out = {} as Record<K, number>;
  for (const field of fields) {
    const n = bag[field];
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new Error(`stats payload missing/non-numeric "${field}"`);
    }
    out[field] = n;
  }
  return out;
}
