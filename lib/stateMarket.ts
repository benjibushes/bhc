// lib/stateMarket.ts — cached market read for the /half-a-cow/[state]
// "the {State} market" strips (farmers-market cross-wiring, 2026-07-15).
//
// BUILD SAFETY (the transient-Airtable-prerender-timeout landmine): all 50
// state pages prerender at build time. Without a lib-level cache each page
// would trigger its own Rancher Products + Ranchers scan (airtable.ts's L1
// TTL is only 10s). This module holds one 5-min in-process cache — the same
// layering as lib/socialProof — so a build's 50 prerenders share ~one read.
//
// FAILURE CONTRACT: null = UNKNOWN. loadMarketplaceProducts swallows its own
// errors into [], and a failed Ranchers join leaves every row geo-blind —
// both are indistinguishable from "empty market" from the outside, so BOTH
// degrade to null here. Callers must render the neutral no-claims copy on
// null; only a real, geo-joined product list may drive supply claims.

import {
  loadMarketplaceProducts,
  type MarketplaceProduct,
} from './marketplaceProducts';

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache: { ts: number; products: MarketplaceProduct[] } | null = null;

/**
 * Chargeable, geo-joined marketplace products (pickup rows included), or
 * null when the truth is unavailable. Stale-if-error: an expired cache
 * entry beats claiming nothing.
 */
export async function getMarketProductsCached(): Promise<MarketplaceProduct[] | null> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.products;
  try {
    const all = await loadMarketplaceProducts({ includeLocal: true, withStates: true });
    // [] may be a swallowed load failure; a set where NO row has any ranch
    // geo means the Ranchers join failed. Either way: unknown, claim nothing.
    const geoKnown = all.some(
      (p) => p.rancherState !== '' || p.rancherServesStates.length > 0,
    );
    if (all.length === 0 || !geoKnown) return _cache ? _cache.products : null;
    // Never surface a product whose checkout would 409 (Connect not active).
    const chargeable = all.filter((p) => p.rancherConnectActive !== false);
    _cache = { ts: Date.now(), products: chargeable };
    return chargeable;
  } catch (err) {
    console.error('[stateMarket] market read failed:', err);
    return _cache ? _cache.products : null;
  }
}
