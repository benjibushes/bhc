// lib/marketStands.ts — PURE ranch-stand logic for the /shop farmers market
// (local-first overhaul 2026-07-15).
//
// The market reads as STALLS, not aisles: products group by ranch, local
// ranches (serving the buyer's state) surface first, everything else sits
// under "shipped nationwide". This module is the whole brain of that layout
// and is deliberately PURE — no Airtable, no env, no fetches — so the client
// grid (app/shop/ShopGrid.tsx) can import it directly and every rule is
// unit-testable (lib/marketStands.test.ts).
//
// HONESTY INVARIANTS enforced here:
//   • A pickup-only product is visible ONLY to a buyer whose state equals the
//     ranch's HOME state (you drive to the ranch — "serves" isn't enough).
//     Unknown buyer state → no pickup products, ever.
//   • standsGeoKnown: when the Ranchers join failed upstream every stand has
//     zero geo data; callers MUST check this and claim nothing about local
//     supply ("no ranch near you" rendered off a failed join would be a lie).

import { normalizeState } from './states';

/** The serializable product shape a stall renders (a ProductCard subset + group key). */
export interface StandProduct {
  id: string;
  name: string;
  price: number;
  rancher: string;
  weight: string;
  image: string;
  shelfStable: boolean;
  depositStyle: boolean;
  priceRange: string;
  ordersLeft: number | null;
  shippingCost: number;
  /** browse-group key (groupKeyForCategory, stamped server-side) */
  group: string;
  /** pickup-at-the-ranch only (Ships Nationwide === false) */
  localOnly: boolean;
}

/** Input row for buildShopStands: a StandProduct + its ranch metadata. */
export interface MarketProductInput extends StandProduct {
  rancherId: string;
  /** ranch home state code ('' unknown) */
  rancherState: string;
  /** home state ∪ States Served, normalized ([] unknown) */
  rancherServesStates: string[];
  /** public page slug ('' = no reachable page — never link) */
  rancherSlug: string;
  /** ranch cover photo URL ('' = none) */
  rancherPhoto: string;
}

/** One ranch stall: the ranch's face + its products. */
export interface ShopStand {
  /** rancherId, or a name-keyed fallback when the row has no record id */
  key: string;
  name: string;
  state: string;
  servesStates: string[];
  slug: string;
  photo: string;
  /** Closed Won deal count (lib/socialProof dealsByRancher); 0 hides the badge */
  deals: number;
  /** nationwide-shippable products (price order preserved from the loader) */
  products: StandProduct[];
  /** pickup-only products — render ONLY for same-home-state buyers */
  pickupProducts: StandProduct[];
}

const toStandProduct = (p: MarketProductInput): StandProduct => ({
  id: p.id,
  name: p.name,
  price: p.price,
  rancher: p.rancher,
  weight: p.weight,
  image: p.image,
  shelfStable: p.shelfStable,
  depositStyle: p.depositStyle,
  priceRange: p.priceRange,
  ordersLeft: p.ordersLeft,
  shippingCost: p.shippingCost,
  group: p.group,
  localOnly: p.localOnly,
});

/**
 * Group products into ranch stands. Stand order: most closed deals first
 * (proof leads), then name A–Z for a stable walk. Product order within a
 * stand is preserved from the input (the loader sorts cheapest-first).
 */
export function buildShopStands(
  items: MarketProductInput[],
  dealsByRancher: Record<string, number> = {},
): ShopStand[] {
  const byKey = new Map<string, ShopStand>();
  for (const p of items) {
    const key = p.rancherId || `name:${p.rancher}`;
    let stand = byKey.get(key);
    if (!stand) {
      stand = {
        key,
        name: p.rancher,
        state: normalizeState(p.rancherState) || '',
        servesStates: p.rancherServesStates || [],
        slug: p.rancherSlug || '',
        photo: p.rancherPhoto || '',
        deals: p.rancherId ? dealsByRancher[p.rancherId] || 0 : 0,
        products: [],
        pickupProducts: [],
      };
      byKey.set(key, stand);
    }
    (p.localOnly ? stand.pickupProducts : stand.products).push(toStandProduct(p));
  }
  return Array.from(byKey.values()).sort(
    (a, b) => b.deals - a.deals || a.name.localeCompare(b.name),
  );
}

/** Does this ranch cover `state` (home state or States Served)? '' → false. */
export function standServes(stand: ShopStand, state: string): boolean {
  const st = normalizeState(state);
  if (!st) return false;
  return stand.state === st || stand.servesStates.includes(st);
}

/**
 * Split stands into the buyer's local market vs. the shipped-nationwide rest.
 * No/unknown state → everything is "nationwide" (the unset default view).
 */
export function splitStandsByState(
  stands: ShopStand[],
  state: string,
): { local: ShopStand[]; nationwide: ShopStand[] } {
  const st = normalizeState(state);
  if (!st) return { local: [], nationwide: stands };
  const local: ShopStand[] = [];
  const nationwide: ShopStand[] = [];
  for (const s of stands) (standServes(s, st) ? local : nationwide).push(s);
  return { local, nationwide };
}

export type StandSort = 'price-asc' | 'price-desc';

/**
 * The products one stall actually shows: nationwide products always; pickup
 * products ONLY when the buyer's state equals the ranch's home state (the
 * "TX buyer never sees an MT pickup product" invariant). Then the category
 * chip filters and the price sort applies within the stall.
 */
export function visibleStandProducts(
  stand: ShopStand,
  buyerState: string,
  group: string,
  sort: StandSort,
): StandProduct[] {
  const st = normalizeState(buyerState);
  const pool =
    st && stand.state === st ? [...stand.products, ...stand.pickupProducts] : stand.products;
  const filtered = group === 'all' ? pool : pool.filter((p) => p.group === group);
  return [...filtered].sort((a, b) =>
    sort === 'price-asc' ? a.price - b.price : b.price - a.price,
  );
}

/**
 * Did the ranch geo join actually run? False ⇒ every stand is geo-blind and
 * NO local/non-local claim may be rendered (the failed-join honesty guard).
 */
export function standsGeoKnown(stands: ShopStand[]): boolean {
  return stands.some((s) => s.state !== '' || s.servesStates.length > 0);
}

/**
 * State-page strip filter: the products a buyer in `state` can actually get
 * locally — nationwide products from ranches covering the state, plus pickup
 * products from ranches HOMED in the state. Unknown state → [].
 * Generic so the server page can pass full MarketplaceProduct rows.
 */
export function marketStripFor<
  T extends { localOnly: boolean; rancherState: string; rancherServesStates: string[] },
>(products: T[], state: string): T[] {
  const st = normalizeState(state);
  if (!st) return [];
  return products.filter((p) =>
    p.localOnly
      ? normalizeState(p.rancherState) === st
      : normalizeState(p.rancherState) === st || p.rancherServesStates.includes(st),
  );
}
