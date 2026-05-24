// Real testimonials pulled from Closed Won referrals.
//
// **Integrity rule: REAL quotes only.** We never put fabricated words
// in a real buyer's mouth — that's impersonation, even with first-name-
// only anonymization. The helper reads explicit `Testimonial` or
// `Quote` text fields on Referrals; if the buyer hasn't supplied one,
// they're excluded from the result. Until Referrals gains those fields
// + the operator collects real quotes, this returns `[]` and callers
// gracefully fall back to clearly-labeled placeholder copy.
//
// Used by /start and /access social-proof slots. Falls back to [] on any
// Airtable error or missing-quote condition so pages never crash.
//
// 5-min in-process cache. Page-level `export const revalidate = 300` on
// callers handles ISR; this cache stops repeated calls within one render
// from re-hitting Airtable.
//
// Privacy: first name only (no last name, no email, no phone). Matches
// the same buyer-anonymization pattern used on /wins.

import { getAllRecords, getRecordById, TABLES } from './airtable';

export interface Testimonial {
  buyerName: string;     // first name only — privacy
  buyerState: string;    // 2-letter abbrev as stored on Referral
  rancherName: string;   // Ranch Name (or Operator Name fallback)
  ranchSlug: string;     // empty string if rancher has no slug
  saleAmount: number;
  orderType: string;     // "Quarter" | "Half" | "Whole" | "Beef" etc.
  quote: string;         // synthesized; brand-voice
  daysAgo: number;       // for "2 weeks ago" UI labels
  closedAt: string;      // ISO string — useful for sorting downstream
}

// 5-min TTL — testimonials don't change minute-to-minute. Bigger than
// the airtable.ts hot cache (10s) because this lib only reads, never
// writes, and stale-by-5-min on a marketing page is fine.
const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache: { ts: number; data: Testimonial[]; limit: number } | null = null;

function firstNameOf(fullName: string): string {
  return (fullName || '').toString().trim().split(/\s+/)[0] || 'a buyer';
}

function daysBetween(iso: string): number {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

/**
 * Fetch recent Closed Won referrals that have an explicit Testimonial
 * or Quote field populated. Returns `[]` on any error OR when no real
 * quotes exist so callers can fall back to placeholder copy without
 * try/catch.
 *
 * Sorted newest-first by Closed At. Skips referrals missing rancher
 * links, zero sale amount (same hygiene rule as /wins), or empty
 * quote field.
 */
export async function getRecentTestimonials(limit: number = 3): Promise<Testimonial[]> {
  // Cache hit — return slice (cached array may be larger than requested limit).
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS && _cache.limit >= limit) {
    return _cache.data.slice(0, limit);
  }

  try {
    // Fetch a healthy pool (max 20) so we can re-slice without re-fetching
    // if the caller asks for a smaller limit on the next call within TTL.
    const poolSize = Math.max(limit, 20);
    const refs = await getAllRecords(TABLES.REFERRALS, '{Status} = "Closed Won"');

    // Sort newest-first by Closed At.
    const sorted = (refs as any[])
      .filter((r) => Number(r['Sale Amount']) > 0)
      .sort((a, b) => {
        const aDate = (a['Closed At'] || '').toString();
        const bDate = (b['Closed At'] || '').toString();
        return bDate > aDate ? 1 : bDate < aDate ? -1 : 0;
      })
      .slice(0, poolSize);

    // Hydrate ranchers. Use linked-record id lookups. We could pre-fetch
    // all ranchers in one shot (like /wins does) but for ≤20 testimonials
    // the per-id lookups are cheaper than pulling the full ranchers table.
    const rancherIds = Array.from(
      new Set(
        sorted
          .map((r) => {
            const ids: string[] = r['Rancher'] || r['Suggested Rancher'] || [];
            return ids[0];
          })
          .filter(Boolean)
      )
    );

    const rancherMap = new Map<string, any>();
    await Promise.all(
      rancherIds.map(async (id) => {
        try {
          const rancher = await getRecordById(TABLES.RANCHERS, id);
          rancherMap.set(id, rancher);
        } catch {
          // missing rancher → testimonial will be skipped below
        }
      })
    );

    const testimonials: Testimonial[] = sorted
      .map((ref) => {
        const ids: string[] = ref['Rancher'] || ref['Suggested Rancher'] || [];
        const rancher = rancherMap.get(ids[0]);
        if (!rancher) return null;

        const buyerName = firstNameOf(ref['Buyer Name'] || '');
        const buyerState = (ref['Buyer State'] || '').toString();
        const rancherName = (rancher['Ranch Name'] || rancher['Operator Name'] || 'a verified rancher').toString();
        const ranchSlug = (rancher['Slug'] || '').toString();
        const saleAmount = Number(ref['Sale Amount']) || 0;
        const orderType = (ref['Order Type'] || 'Beef').toString();
        const closedAt = (ref['Closed At'] || '').toString();

        // REAL QUOTES ONLY. If the buyer hasn't supplied a Testimonial
        // or Quote, exclude them — never fabricate words attributed to
        // a real named buyer (impersonation). Operator collects real
        // quotes via post-purchase email + writes into the field.
        const explicit = (ref['Testimonial'] || ref['Quote'] || '').toString().trim();
        if (!explicit) return null;
        const quote = explicit;

        return {
          buyerName,
          buyerState,
          rancherName,
          ranchSlug,
          saleAmount,
          orderType,
          quote,
          daysAgo: daysBetween(closedAt),
          closedAt,
        } satisfies Testimonial;
      })
      .filter((t): t is Testimonial => t !== null);

    _cache = { ts: Date.now(), data: testimonials, limit: poolSize };
    return testimonials.slice(0, limit);
  } catch (err) {
    console.error('[testimonials] fetch failed, returning empty:', err);
    return [];
  }
}
