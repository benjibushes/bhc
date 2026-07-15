import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, TABLES } from '@/lib/airtable';
import { isRancherOperationalForBuyers } from '@/lib/rancherEligibility';
import { FOUNDING_BRAND_PARTNER_CAP } from '@/lib/tiers';
import { cacheGet as sharedCacheGet, cacheSet as sharedCacheSet } from '@/lib/sharedCache';

export const runtime = 'nodejs';
// Cache 5 minutes — public stats don't need to be real-time. ISR
// + edge cache means most requests hit cache, not Airtable.
export const revalidate = 300;

// ── Shared-cache layer (bulletproof walkthrough 2026-07-15) ────────────────
// Prod showed intermittent 10s AirtableTimeoutErrors here: every uncached hit
// ran live full-table scans of Consumers + Referrals (+Ranchers +Brands).
// `revalidate = 300` alone wasn't protecting us (the Upstash no-store fetch
// inside the allowlisted Ranchers read flipped the route dynamic at runtime —
// fixed in lib/sharedCache — and any cache-miss/timing gap still paid the full
// scan). Defense in depth, same L1/L2 pattern as /api/funnel/stats:
//   L1: in-process, 10-min TTL, single-flight so a cold-instance burst
//       computes ONCE instead of N parallel full scans.
//   L2: shared Redis (fail-open no-op without Upstash env) so the whole
//       fleet shares one compute per TTL window.
//   Stale-on-error: the last good payload is kept for 24h (L1 reference +
//       a long-TTL Redis key) and served when Airtable times out — a public
//       page should get slightly-old truth, never a hardcoded guess.
const STATS_TTL_MS = 10 * 60 * 1000;
const STATS_REDIS_KEY = 'publicstats:cache:v1';
const STATS_STALE_REDIS_KEY = 'publicstats:stale:v1';
const STATS_STALE_TTL_MS = 24 * 60 * 60 * 1000;
let _statsCache: { at: number; data: Record<string, any> } | null = null;
let _statsLastGood: Record<string, any> | null = null;
let _statsInFlight: Promise<Record<string, any>> | null = null;

const FOUNDERS_CAP = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

interface LatestClose {
  firstName: string;
  orderType: string;
  ranchName: string;
  ranchSlug: string;
  buyerState: string;
  daysAgo: number;
}

interface Activity24h {
  closes: number;
  matched: number;
  signups: number;
}

interface PublicStats {
  ranchersActive: number;
  familiesMatched: number;
  foundersBacked: number;
  foundersCap: number;
  totalClosedWon: number;
  thisMonthClosedWon: number;
  // Extended fields — power /start LIVE badge + 24h activity strip
  // without /start needing to make additional Airtable calls. Single
  // cached endpoint feeds the landing page.
  latestClose: LatestClose | null;
  activity24h: Activity24h;
  // Brand Partner Founding 100 — slots remaining (cap minus active
  // paid brand partners). Powers /brand-partners scarcity counter.
  brandPartnersRemaining: number;
}

// The live compute — full-table reads. Throws on Airtable failure; the GET
// wrapper below owns caching + stale-on-error + the last-ditch fallback.
async function computeStats(): Promise<Record<string, any>> {
  {
    const [ranchers, consumers, referrals, brands] = await Promise.all([
      getAllRecords(TABLES.RANCHERS) as Promise<any[]>,
      getAllRecords(TABLES.CONSUMERS) as Promise<any[]>,
      getAllRecords(TABLES.REFERRALS) as Promise<any[]>,
      // Brands table may be empty / missing in fresh envs — soft-fail to []
      // so brandPartnersRemaining falls back to the cap (100 spots open).
      (getAllRecords(TABLES.BRANDS) as Promise<any[]>).catch(() => [] as any[]),
    ]);

    const ranchersActive = ranchers.filter((r: any) => isRancherOperationalForBuyers(r)).length;

    // "Families in pipeline" = anyone past raw lead status.
    // Includes NEW (just signed up) + WAITING (no rancher in state yet) +
    // READY (rancher exists, hasn't engaged) + MATCHED (intro fired) +
    // CLOSED (purchased or ghosted). Excludes nothing — fresh signups
    // should show in the public counter so /start + /access reflect real
    // pipeline depth, not just downstream-cron-promoted records.
    const familiesMatched = consumers.filter((c: any) => {
      const stage = (c['Buyer Stage'] || '').toString();
      const status = (c['Status'] || '').toString();
      // Stage-based count if Buyer Stage set
      if (stage) {
        return ['NEW', 'WAITING', 'READY', 'MATCHED', 'CLOSED'].includes(stage);
      }
      // Fallback for legacy records w/o Buyer Stage: count Approved
      return status === 'Approved';
    }).length;

    const foundersBacked = consumers.filter((c: any) => !!c['Founder Tier']).length;

    const closedWon = referrals.filter((r: any) => r['Status'] === 'Closed Won');
    const totalClosedWon = closedWon.length;

    const firstOfMonth = new Date();
    firstOfMonth.setDate(1);
    firstOfMonth.setHours(0, 0, 0, 0);
    const thisMonthClosedWon = closedWon.filter((r: any) => {
      const closedAt = r['Closed At'] ? new Date(r['Closed At']).getTime() : 0;
      return closedAt >= firstOfMonth.getTime();
    }).length;

    // ── 24h activity counters ────────────────────────────────────────
    const since = Date.now() - DAY_MS;
    const closes24h = closedWon.filter((r: any) => {
      const t = r['Closed At'] ? new Date(r['Closed At']).getTime() : 0;
      return t >= since;
    }).length;
    const matched24h = referrals.filter((r: any) => {
      const t = r['Intro Sent At'] ? new Date(r['Intro Sent At']).getTime() : 0;
      return t >= since;
    }).length;
    const signups24h = consumers.filter((c: any) => {
      const t = c['Created'] || c['Created At'] || c._createdTime || '';
      const ts = t ? new Date(t.toString()).getTime() : 0;
      return ts >= since;
    }).length;

    // ── Latest Closed Won referral (hydrated w/ rancher) ─────────────
    let latestClose: LatestClose | null = null;
    if (closedWon.length > 0) {
      const sorted = [...closedWon]
        .filter((r: any) => Number(r['Sale Amount']) > 0)
        .sort((a: any, b: any) => {
          const aT = new Date((a['Closed At'] || '').toString()).getTime() || 0;
          const bT = new Date((b['Closed At'] || '').toString()).getTime() || 0;
          return bT - aT;
        });
      if (sorted.length > 0) {
        const ref = sorted[0];
        const buyerName = (ref['Buyer Name'] || '').toString();
        const firstName = buyerName.trim().split(/\s+/)[0] || 'a buyer';
        const orderType = (ref['Order Type'] || 'Beef').toString();
        const buyerState = (ref['Buyer State'] || '').toString();
        const closedAt = (ref['Closed At'] || '').toString();
        const daysAgo = closedAt
          ? Math.max(0, Math.floor((Date.now() - new Date(closedAt).getTime()) / DAY_MS))
          : 0;
        let ranchName = 'a verified rancher';
        let ranchSlug = '';
        const rancherIds: string[] = (ref['Rancher'] || []) as string[];
        if (rancherIds[0]) {
          try {
            const rancher: any = await getRecordById(TABLES.RANCHERS, rancherIds[0]);
            ranchName = (rancher['Ranch Name'] || rancher['Operator Name'] || ranchName).toString();
            ranchSlug = (rancher['Slug'] || '').toString();
          } catch {
            // fall through w/ generic ranchName
          }
        }
        latestClose = { firstName, orderType, ranchName, ranchSlug, buyerState, daysAgo };
      }
    }

    // ── Brand Partners — Founding 100 slots remaining ────────────────
    // A "claimed" Founding 100 slot = a brand that has actually paid.
    // We use Payment Status = 'Paid' as the canonical signal (set by
    // the Stripe webhook in handleBrandListingCompleted). Featured=true
    // alone isn't enough — that's a manual editorial flag and can be
    // true on unpaid records. Anything else (Pending / Approved-but-
    // unpaid) doesn't burn a slot.
    const activeBrandPartners = brands.filter((b: any) => {
      const paymentStatus = (b['Payment Status'] || '').toString();
      return paymentStatus === 'Paid';
    }).length;
    const brandPartnersRemaining = Math.max(
      0,
      FOUNDING_BRAND_PARTNER_CAP - activeBrandPartners,
    );

    // Distinct US states with at least one operational rancher.
    // Used by homepage LiveCounter `stateCount` field.
    const stateCount = new Set(
      ranchers
        .filter((r: any) => isRancherOperationalForBuyers(r))
        .map((r: any) => (r['State'] || '').toString().trim().toUpperCase())
        .filter(Boolean),
    ).size;

    const stats = {
      ranchersActive,
      familiesMatched,
      foundersBacked,
      foundersCap: FOUNDERS_CAP,
      totalClosedWon,
      thisMonthClosedWon,
      latestClose,
      activity24h: { closes: closes24h, matched: matched24h, signups: signups24h },
      brandPartnersRemaining,
      // ── Legacy key aliases ──────────────────────────────────────────
      // The homepage FullHomepage + LiveCounter were built against an
      // older API shape (rancherCount / buyerCount / stateCount). Adding
      // aliases here keeps them rendering without forcing a client-side
      // refactor. New consumers (/start, /access) use the canonical keys.
      rancherCount: ranchersActive,
      buyerCount: familiesMatched,
      stateCount,
      ranchers: ranchersActive,
      buyers: familiesMatched,
      states: stateCount,
      verifiedRancherCount: ranchersActive,
      beefBuyerCount: familiesMatched,
      verifiedStateCount: stateCount,
    };

    return stats;
  }
}

function statsResponse(stats: Record<string, any>): NextResponse {
  return NextResponse.json(stats, {
    headers: {
      'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
    },
  });
}

export async function GET() {
  try {
    // L1 — in-process, fresh.
    if (_statsCache && Date.now() - _statsCache.at < STATS_TTL_MS) {
      return statsResponse(_statsCache.data);
    }
    // L2 — shared Redis (no-op MISS when Upstash env is unset).
    const shared = await sharedCacheGet<Record<string, any>>(STATS_REDIS_KEY);
    if (shared !== undefined) {
      _statsCache = { at: Date.now(), data: shared };
      _statsLastGood = shared;
      return statsResponse(shared);
    }
    // Single-flight live compute — a cold-instance burst pays ONE scan set.
    if (!_statsInFlight) {
      _statsInFlight = computeStats().finally(() => {
        _statsInFlight = null;
      });
    }
    const stats = await _statsInFlight;
    _statsCache = { at: Date.now(), data: stats };
    _statsLastGood = stats;
    // Both writes are fail-safe no-ops without Redis. The long-TTL stale key
    // is the fleet-wide stale-on-error copy.
    await sharedCacheSet(STATS_REDIS_KEY, stats, STATS_TTL_MS);
    await sharedCacheSet(STATS_STALE_REDIS_KEY, stats, STATS_STALE_TTL_MS);
    return statsResponse(stats);
  } catch (error: any) {
    console.error('/api/stats/public error:', error?.message);
    // Stale-on-error: last good beats a hardcoded guess. In-process first,
    // then the fleet-wide 24h Redis copy.
    const stale =
      _statsLastGood ??
      (await sharedCacheGet<Record<string, any>>(STATS_STALE_REDIS_KEY));
    if (stale) {
      return NextResponse.json(stale, {
        headers: { 'Cache-Control': 'public, max-age=60' },
      });
    }
    const fallback = {
      ranchersActive: 17,
      familiesMatched: 1533,
      foundersBacked: 0,
      foundersCap: FOUNDERS_CAP,
      totalClosedWon: 11,
      thisMonthClosedWon: 0,
      latestClose: null,
      activity24h: { closes: 0, matched: 0, signups: 0 },
      // Conservative fallback — show 5 spots remaining (matches the
      // pre-wired hardcode on /brand-partners) when Airtable is down.
      brandPartnersRemaining: 5,
      // Legacy aliases for FullHomepage + LiveCounter compatibility.
      rancherCount: 17,
      buyerCount: 1533,
      stateCount: 5,
      ranchers: 17,
      buyers: 1533,
      states: 5,
      verifiedRancherCount: 17,
      beefBuyerCount: 1533,
      verifiedStateCount: 5,
    };
    return NextResponse.json(fallback, {
      status: 200,
      headers: { 'Cache-Control': 'public, max-age=60' },
    });
  }
}
