// Live social-proof aggregates from Closed Won referrals.
//
// The competitive audit's cheapest trust gap (2026-07-14): real closed deals
// exist in Airtable but rendered ONLY on /wins — the money pages where buyers
// hesitate (deposit checkout, /shop, the state SEO pages, rancher storefronts)
// showed zero proof. This helper is the single source for those surfaces.
//
// HONESTY RULES (same as /wins + lib/testimonials.ts):
//   • LIVE-derived only — never a hardcoded count or GMV (they grow).
//   • Same hygiene filter as /wins: Status = Closed Won, Sale Amount > 0,
//     a real rancher link. No padding, no floors.
//   • GMV rounds DOWN to "$30k+" style — we understate, never overstate.
//   • On any Airtable failure callers get null → surfaces render NOTHING
//     (no lie, no zeroes). A failed fetch must never read as "0 deals".
//
// Privacy: this module exposes AGGREGATES ONLY — counts, GMV, and a
// "half cow — TX, jul 2026" latest-win label. No buyer names ever leave it.
//
// Caching: 5-min in-process TTL, mirroring lib/testimonials.ts (Referrals is
// deliberately NOT in the airtable.ts L1/L2 allowlist — money reads stay
// live — so this lib-level cache is what keeps /shop + 50 state pages +
// rancher pages from full-scanning Referrals per render). Page-level ISR
// (`export const revalidate`) on callers handles CDN freshness.

import { getAllRecords, TABLES, withTimeout, resolveAirtableTimeoutMs } from './airtable';

export interface SocialProofStats {
  deals: number;                        // Closed Won count (same filter as /wins)
  gmv: number;                          // raw dollars — for internal use
  gmvLabel: string;                     // "$30k+" — honest floor-rounded label
  latestWinLabel: string | null;        // "half cow — TX, jul 2026"
  dealsByRancher: Record<string, number>; // rancher recordId → closed-deal count
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache: { ts: number; stats: SocialProofStats } | null = null;

/**
 * Honest GMV label: floor to the nearest $1k with a "+" ($30,800 → "$30k+")
 * so the claim is always an understatement. Below $1k, exact dollars, no "+".
 * Empty string for zero/invalid — callers drop the segment entirely.
 */
export function formatGmvLabel(gmv: number): string {
  if (!Number.isFinite(gmv) || gmv <= 0) return '';
  if (gmv < 1000) return `$${Math.round(gmv).toLocaleString('en-US')}`;
  return `$${Math.floor(gmv / 1000)}k+`;
}

// Order Type on Referrals is "Quarter" | "Half" | "Whole" | "Beef" (etc).
// Share tiers read as "half cow"; anything else falls back to the raw value
// lowercased ("beef") — never invented.
function orderTypeLabel(orderType: string): string {
  const t = (orderType || '').trim().toLowerCase();
  if (t === 'quarter' || t === 'half' || t === 'whole') return `${t} cow`;
  return t || 'beef';
}

/**
 * "half cow — TX, jul 2026" from the raw referral fields. State and month
 * segments drop independently when missing/invalid — never placeholders.
 * Lowercase per brand copy rules (state codes stay uppercase).
 */
export function buildLatestWinLabel(
  orderType: string,
  buyerState: string,
  closedAtIso: string,
): string | null {
  const type = orderTypeLabel(orderType);
  const state = (buyerState || '').toString().trim().toUpperCase();
  let month = '';
  if (closedAtIso) {
    const d = new Date(closedAtIso);
    if (Number.isFinite(d.getTime())) {
      month = d
        .toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
        .toLowerCase();
    }
  }
  const tail = [state, month].filter(Boolean).join(', ');
  if (!tail) return type || null;
  return `${type} — ${tail}`;
}

/**
 * Pure aggregation over raw Closed Won referral rows (exported for tests).
 * Filter matches /wins exactly: a real rancher link + Sale Amount > 0.
 * Per-rancher counts credit the primary linked rancher (ids[0]) — the same
 * attribution /wins uses to render the card.
 */
export function summarizeClosedWonRefs(
  refs: Array<Record<string, any>>,
): SocialProofStats {
  let gmv = 0;
  let deals = 0;
  const dealsByRancher: Record<string, number> = {};
  let latest: Record<string, any> | null = null;
  let latestClosedAt = '';

  for (const ref of refs) {
    const rancherIds: string[] = ref['Rancher'] || ref['Suggested Rancher'] || [];
    const saleAmount = Number(ref['Sale Amount']) || 0;
    if (!rancherIds.length || saleAmount <= 0) continue;

    deals += 1;
    gmv += saleAmount;
    dealsByRancher[rancherIds[0]] = (dealsByRancher[rancherIds[0]] || 0) + 1;

    const closedAt = (ref['Closed At'] || '').toString();
    if (!latest || closedAt > latestClosedAt) {
      latest = ref;
      latestClosedAt = closedAt;
    }
  }

  return {
    deals,
    gmv,
    gmvLabel: formatGmvLabel(gmv),
    latestWinLabel: latest
      ? buildLatestWinLabel(
          (latest['Order Type'] || '').toString(),
          (latest['Buyer State'] || '').toString(),
          latestClosedAt,
        )
      : null,
    dealsByRancher,
  };
}

/**
 * Fetch + summarize Closed Won referrals. Returns null on ANY failure so
 * callers render nothing rather than a zero-claim lie. Serves a stale cached
 * value over null when Airtable blips mid-TTL-expiry.
 */
export async function getSocialProofStats(): Promise<SocialProofStats | null> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.stats;
  try {
    // withTimeout — ProofStrip renders inside statically prerendered pages
    // (/shop + all 50 /half-a-cow/[state]); a stalled Airtable read here
    // must fail fast into the catch, never hang a Vercel build (the known
    // transient prerender-timeout killer).
    const refs = (await withTimeout(
      getAllRecords(TABLES.REFERRALS, '{Status} = "Closed Won"'),
      resolveAirtableTimeoutMs(),
      'socialProof closed-won referrals',
    )) as Array<Record<string, any>>;
    const stats = summarizeClosedWonRefs(refs);
    _cache = { ts: Date.now(), stats };
    return stats;
  } catch (err) {
    console.error('[socialProof] fetch failed:', err);
    // Stale-if-error: an expired cache entry beats rendering nothing.
    return _cache ? _cache.stats : null;
  }
}

/**
 * Honest closed-deal count for one rancher (record id). 0 on any failure —
 * the badge simply hides; a fetch error must never fabricate a count.
 */
export async function getClosedWonDealCountForRancher(
  rancherId: string,
): Promise<number> {
  if (!rancherId) return 0;
  const stats = await getSocialProofStats();
  return stats?.dealsByRancher[rancherId] || 0;
}
