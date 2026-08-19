// lib/airtableCachePolicy.ts
//
// PER-TABLE, PER-LAYER CACHE TTLs (capacity audit 2026-08-19).
//
// Before this module lib/airtable.ts used ONE `CACHE_TTL_MS = 10_000` for both
// cache layers and all three cached tables. The Ranchers full-table read
// therefore expired six times a minute, and every expiry under sustained
// traffic sent a fresh full scan at Airtable. That is the storm surface: an
// ordinary ad burst (~8-25 concurrent /access visitors landing on one cache
// boundary) is enough to exceed Airtable's ~5 req/s per-base ceiling, and the
// penalty for that is a 30-SECOND lockout of the entire base.
//
// ── WHY THE TWO LAYERS GET DIFFERENT NUMBERS ────────────────────────────────
// The obvious fix — "just raise the TTL" — is wrong, because the two layers
// bound two different things:
//
//   L1  in-process, per lambda.  BOUNDS STALENESS.
//       A write busts L1 only on the instance that performed it. Every OTHER
//       warm instance keeps serving its own copy until that copy expires. So
//       L1 TTL is the fleet-wide answer to "how long can a rancher who just
//       went live stay invisible to a buyer?" It must stay SHORT. It is
//       UNCHANGED at 10s for both money-path tables.
//
//   L2  Upstash Redis, shared by every instance.  BOUNDS AIRTABLE REQUEST RATE.
//       Writes delete the shared key GLOBALLY (invalidateAirtableCache →
//       cacheDel, which lib/airtable.ts now AWAITS on the write path — an
//       un-awaited delete could be lost to a frozen lambda and leave the stale
//       value serving for a full TTL). Because an in-app write reliably clears
//       it, a long L2 TTL is safe against in-app writes, and it is the thing
//       that actually collapses the read storm.
//
// Net effect: in-app write visibility is UNCHANGED (bounded by the unchanged
// 10s L1), while Airtable read frequency for the hot tables drops ~6x.
//
// ── THE STALENESS THAT DOES GROW, stated plainly ────────────────────────────
// Edits made OUTSIDE this app bypass both layers and are bounded only by TTL:
//   • the founder flipping a field in the Airtable UI (e.g. Active Status —
//     the "rancher is non-routable until Ben sets Active Status=Active"
//     landmine), or an Airtable MCP/automation write;
//   • the separate ~/bhc-prospects-dashboard deployment, which PATCHes
//     Ranchers directly (its own allowlist is Last Touch At / Last Touch Note,
//     i.e. no money field today — but that is enforced over there, not here).
// Those go from "visible within ~10s" to "visible within ~70s" (L2 60s + one
// L1 60s... see WORST-CASE below). That is the price of the change and it is
// the right price: none of those edits are on a request-latency path.
//
// WORST CASE: a value can sit in L2 until its EX expires and then live another
// full L1 TTL on whichever instance pulls it, so observable staleness is
// (l1Ms + l2Ms), not l2Ms. Pinned by airtableCachePolicy.test.ts.
//
// Import-clean (no Airtable SDK, no env read at load) so it unit-tests
// hermetically and can be imported from anywhere without a cycle.

export interface CacheTtlPolicy {
  /** In-process TTL. Bounds how stale a NON-writing instance can be. */
  l1Ms: number;
  /** Shared-Redis TTL. Bounds how often anyone re-reads Airtable. */
  l2Ms: number;
  why: string;
}

/**
 * Tables whose cached rows feed a price, a deposit, a capacity/slot count, or
 * a routable/payable gate. Their L1 TTL is the one number in this file that
 * must never be raised — see MAX_MONEY_PATH_L1_TTL_MS.
 */
export const MONEY_PATH_TABLES: ReadonlySet<string> = new Set(['Ranchers', 'Rancher Products']);

/** Hard ceiling on the money-path L1 TTL. Pinned by a test; do not raise. */
export const MAX_MONEY_PATH_L1_TTL_MS = 10_000;

export const AIRTABLE_CACHE_POLICY: Readonly<Record<string, CacheTtlPolicy>> = {
  // The storm table. /access, /shop, matching/suggest, consumers signup and 30+
  // crons all full-scan it. Its cached rows decide routability
  // (isRancherOperationalForBuyers), remaining capacity (Current Active
  // Referrals vs Max Active Referalls) and tier price → deposit, so L1 STAYS at
  // 10s. L2 at 60s is what takes the Airtable read rate from 6/min to 1/min.
  Ranchers: {
    l1Ms: 10_000,
    l2Ms: 60_000,
    why: 'routability + capacity + tier price come off this row; L1 stays 10s for freshness, L2 60s kills the read storm',
  },
  // Display Price / Rancher Base / Orders Left render on /shop, /access and
  // every rancher page. Every actual CHARGE re-reads the row live by id
  // (checkout/product, checkout/deposit, loadMarketplaceProductAnyStock), so
  // the cache is display-only — but a sold-out product staying listed is a
  // buyer-visible lie, so L1 stays at 10s here too.
  'Rancher Products': {
    l1Ms: 10_000,
    l2Ms: 60_000,
    why: 'display prices + Orders Left stock; charges re-read live by id, but a stale sold-out listing is buyer-visible',
  },
  // Curated affiliate gear. Hand-maintained in the Airtable UI (this codebase
  // never writes it), read by /gear and /api/gear, and touches no BHC money
  // math. Nothing here needs to be fresh in seconds.
  'Recommended Products': {
    l1Ms: 30_000,
    l2Ms: 300_000,
    why: 'hand-curated affiliate content, weekly-fresh at best, zero money math — the safest table to cache hard',
  },
};

/**
 * The allowlist. Everything else — Consumers, Referrals, Payments, Rancher
 * Orders, and every log table — is read LIVE. Capacity and money logic must
 * never be answered from a cache.
 */
export const CACHEABLE_TABLES: ReadonlySet<string> = new Set(Object.keys(AIRTABLE_CACHE_POLICY));

export function isCacheableTable(tableName: string): boolean {
  return CACHEABLE_TABLES.has(tableName);
}

/** In-process TTL for `tableName`, or 0 when the table is not cacheable. */
export function l1TtlMs(tableName: string): number {
  return AIRTABLE_CACHE_POLICY[tableName]?.l1Ms ?? 0;
}

/** Shared-Redis TTL for `tableName`, or 0 when the table is not cacheable. */
export function l2TtlMs(tableName: string): number {
  return AIRTABLE_CACHE_POLICY[tableName]?.l2Ms ?? 0;
}
