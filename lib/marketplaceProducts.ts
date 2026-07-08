// lib/marketplaceProducts.ts
//
// Single source of truth for the nationwide-shippable product marketplace.
// The marketplace index, the product page, and the sitemap all load through
// here so the "what's sellable" rule lives in exactly one place.
//
// INCLUSION RULE (the money-integrity filter):
//   Active === true                 — rancher/ops flipped it live
//   Ships Nationwide !== false       — reuse the existing checkbox; blank counts
//                                      as shippable, only an explicit un-check hides it
//   Display Price > 0                — has a buyer price
//   Rancher Base > 0                 — has a rancher payout
//   Rancher Base <= Display Price    — margin (application_fee) can never be negative
//
// Category (Snack Sticks / Jerky / Sampler Box / Ground Box / Bundle / Eighth
// Share) is the browse axis. Resistance Tier stays available for the warm
// downsell entry but is NOT how the marketplace organizes itself.

import { getAllRecords, getRecordById, TABLES } from '@/lib/airtable';
import { normalizeState } from '@/lib/states';

export interface MarketplaceProduct {
  id: string;
  name: string;
  rancher: string;
  category: string;
  tier: string;
  price: number;
  base: number;
  weight: string;
  shelfStable: boolean;
  image: string;
  description: string;
  // DEPOSIT-STYLE (price-range products, e.g. the $95–355 ground beef box):
  // Display Price is charged as a DEPOSIT today; the rancher confirms size/
  // details with the buyer and collects the balance before shipping. Pure
  // presentation flags — the checkout mechanics (charge Display Price, skim
  // Display−Base as the fee) are identical to a fixed-price product.
  depositStyle: boolean;
  priceRange: string;
  // Inventory: null = unlimited (blank in Airtable); a number = orders left.
  // Real scarcity only — surfaces may show "N left" because it's true.
  ordersLeft: number | null;
  // PRODUCT INFO (Phase 12 — the information gap): what a buyer actually GETS
  // and how the process works. All optional; PDP falls back to honest generic
  // copy when blank. whatsIncluded is newline-separated (renders as a list).
  whatsIncluded: string;
  shipsInDays: number | null;
  packaging: string;
  feeds: string;
  // Owner key ('Rancher Record ID' on the row) — lets the rancher's public
  // landing page list THEIR live products (the Silverline gap: products sold
  // on /shop but invisible on /ranchers/<slug>).
  rancherId: string;
  // Per-order shipping charge in dollars (0 = shipping included in price).
  // Buyer pays it at checkout as a separate line; rancher keeps 100% of it.
  shippingCost: number;
  // LOCAL PICKUP (2026-07-07): Ships Nationwide un-checked no longer means
  // "delisted" (Active/hide is the delist switch) — it means the product is
  // pickup-at-the-ranch only. Local products render on the rancher's own page
  // (labeled) and — farmers market 2026-07-08 — in /shop's "near you" rail
  // for buyers whose state matches the ranch. Never the ad feed or cold
  // funnels; checkout charges no shipping and every surface says pickup.
  localOnly: boolean;
  // BYOC Tier 2 (2026-07-08): the rancher's own store link for this product.
  // When set, the rancher-page card links out via /go/[id] instead of BHC
  // checkout. NEVER surfaces on /shop or the funnel rails (money integrity).
  externalCheckoutUrl: string;
  // Ranch home state (normalized 2-letter code, '' unknown) — joined from the
  // Ranchers table so the farmers-market rail can match pickup products to
  // the buyer's state. Populated by loadMarketplaceProducts; single-product
  // loaders leave it '' (the PDP doesn't need it).
  rancherState: string;
}

const sel = (v: any) => (v && typeof v === 'object' ? v.name : v) || '';

/**
 * The money-integrity gate: is this Rancher Products row sellable on the
 * marketplace? Pure so it can be unit-tested — the `base <= price` clause is the
 * load-bearing invariant (a row that would produce a NEGATIVE BHC margin must
 * never be listed or checked out). `Ships Nationwide !== false` includes true +
 * blank (safe default), excludes only an explicit un-check.
 */
export function isSellableRow(r: any): boolean {
  const price = Number(r?.['Display Price'] || 0);
  const base = Number(r?.['Rancher Base'] || 0);
  return (
    r?.['Active'] === true &&
    r?.['Ships Nationwide'] !== false &&
    price > 0 &&
    base > 0 &&
    base <= price &&
    // INVENTORY (Phase 11, ad-readiness): 'Orders Left' blank = unlimited
    // (every pre-inventory row keeps selling); a number must be > 0. A
    // sold-out product must never be listed or charged — ads can't oversell.
    hasStock(r)
  );
}

/** Inventory gate, standalone so charge-time routes can reuse it verbatim. */
export function hasStock(r: any): boolean {
  const left = r?.['Orders Left'];
  if (left === undefined || left === null || left === '') return true; // blank = unlimited
  return Number(left) > 0;
}

/**
 * LOCAL-PICKUP sellable: every isSellableRow gate EXCEPT the nationwide
 * clause is inverted — Ships Nationwide must be EXPLICITLY false. These rows
 * sell with pickup semantics on the rancher's own page only.
 */
export function isLocalPickupRow(r: any): boolean {
  const price = Number(r?.['Display Price'] || 0);
  const base = Number(r?.['Rancher Base'] || 0);
  return (
    r?.['Active'] === true &&
    r?.['Ships Nationwide'] === false &&
    price > 0 &&
    base > 0 &&
    base <= price &&
    hasStock(r)
  );
}

/**
 * Load every sellable nationwide-shippable product, cheapest first.
 * `includeLocal: true` ALSO returns local-pickup rows (tagged localOnly) —
 * used ONLY by the rancher's own landing page; /shop, the ad feed, and the
 * cold funnel rails stay nationwide-only so a TX buyer never sees a MT
 * pickup product outside that ranch's page.
 */
export async function loadMarketplaceProducts(
  opts?: { includeLocal?: boolean; withStates?: boolean },
): Promise<MarketplaceProduct[]> {
  let rows: any[] = [];
  try {
    rows = (await getAllRecords(TABLES.RANCHER_PRODUCTS)) as any[];
  } catch {
    return [];
  }
  // Ranch-state join for the farmers-market rail — OPT-IN via withStates
  // (only /shop needs it). PROD INCIDENT 2026-07-08: doing this join
  // unconditionally put a full Ranchers read on EVERY rancher-page render;
  // the shared Redis cache can't serve inside prerender contexts (no-store
  // fetch → "Dynamic server usage" → treated as miss), so each render hit
  // Airtable raw and expired-ISR rancher pages started timing out into
  // 500s. Best-effort: on failure every product gets rancherState '' and
  // the local rail simply doesn't render.
  const stateByRancher: Record<string, string> = {};
  if (opts?.withStates === true) {
    try {
      for (const r of (await getAllRecords(TABLES.RANCHERS)) as any[]) {
        stateByRancher[r.id] = normalizeState(r['State']) || '';
      }
    } catch { /* rail degrades to nationwide-only */ }
  }
  return rows
    .filter((r) => isSellableRow(r) || (opts?.includeLocal === true && isLocalPickupRow(r)))
    .map((r) => ({
      id: r.id,
      name: String(r['Product Name'] || ''),
      rancher: String(r['Rancher Name'] || ''),
      category: String(sel(r['Category']) || 'Other'),
      tier: String(sel(r['Resistance Tier']) || ''),
      price: Number(r['Display Price'] || 0),
      base: Number(r['Rancher Base'] || 0),
      weight: String(r['Weight / Size'] || ''),
      shelfStable: !!r['Shelf Stable'],
      image: String(r['Image URL'] || ''),
      description: String(r['Description'] || ''),
      depositStyle: r['Deposit Style'] === true,
      priceRange: String(r['Price Range'] || ''),
      ordersLeft:
        r['Orders Left'] === undefined || r['Orders Left'] === null || r['Orders Left'] === ''
          ? null
          : Number(r['Orders Left']),
      whatsIncluded: String(r["What's Included"] || ''),
      shipsInDays: Number(r['Ships In Days']) > 0 ? Number(r['Ships In Days']) : null,
      packaging: String(r['Packaging'] || ''),
      feeds: String(r['Feeds'] || ''),
      rancherId: String(r['Rancher Record ID'] || '').trim(),
      shippingCost: Math.max(0, Number(r['Shipping Cost'] || 0)),
      localOnly: r['Ships Nationwide'] === false,
      externalCheckoutUrl: String(r['External Checkout URL'] || '').trim(),
      rancherState: stateByRancher[String(r['Rancher Record ID'] || '').trim()] || '',
    }))
    .sort((a, b) => a.price - b.price);
}

/**
 * Farmers-market filter (pure, tested): the local-pickup products a buyer in
 * `buyerState` can actually go get. Accepts raw region strings ('TX',
 * 'Texas'); unknown/empty buyer state or unknown ranch state → no matches
 * (never show a pickup product the buyer can't reach).
 */
export function localMarketFor(
  products: MarketplaceProduct[],
  buyerState: string,
): MarketplaceProduct[] {
  const st = normalizeState(buyerState);
  if (!st) return [];
  return products.filter((p) => p.localOnly && p.rancherState === st);
}

/** Pure filter: the products owned by one rancher (record id match). */
export function productsForRancher(
  products: MarketplaceProduct[],
  rancherId: string,
): MarketplaceProduct[] {
  const id = String(rancherId || '').trim();
  if (!id) return [];
  return products.filter((p) => p.rancherId === id);
}

/**
 * Load one rancher's live sellable products (for their public landing page).
 * INCLUDES local-pickup rows — the rancher's own page is exactly where their
 * local buyers land, so pickup products belong here (labeled) and nowhere else.
 */
export async function loadProductsForRancher(rancherId: string): Promise<MarketplaceProduct[]> {
  return productsForRancher(await loadMarketplaceProducts({ includeLocal: true }), rancherId);
}

/** Load one product by record id — returns null if missing or not sellable. */
export async function loadMarketplaceProduct(id: string): Promise<MarketplaceProduct | null> {
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) return null;
  const all = await loadMarketplaceProducts();
  return all.find((p) => p.id === id) || null;
}

/**
 * Load one product ALLOWING sold-out (GTM-hardening F4). The checkout wrapper
 * needs to render an honest "just sold out" state for a buyer arriving from a
 * stale (ISR) PDP — a 404 there burns exactly the ad clicks the sold-out PDP
 * design exists to save. Anything unsellable for a non-stock reason is still
 * null (real 404). soldOut mirrors hasStock, fail-closed on junk values.
 */
export async function loadMarketplaceProductAnyStock(
  id: string,
): Promise<{ product: MarketplaceProduct; soldOut: boolean } | null> {
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) return null;
  let r: any;
  try {
    r = await getRecordById(TABLES.RANCHER_PRODUCTS, id);
  } catch {
    return null;
  }
  if (!r) return null;
  const price = Number(r['Display Price'] || 0);
  const base = Number(r['Rancher Base'] || 0);
  // LOCAL PICKUP: Ships Nationwide=false is a sellable pickup product now
  // (labeled + charged with pickup semantics), NOT a delist — Active is the
  // delist switch. So the nationwide clause is no longer a 404 condition.
  const sellableExceptStock =
    r['Active'] === true &&
    price > 0 &&
    base > 0 &&
    base <= price;
  if (!sellableExceptStock) return null;
  const sel = (v: any) => (v && typeof v === 'object' ? v.name : v) || '';
  return {
    product: {
      id: r.id,
      name: String(r['Product Name'] || ''),
      rancher: String(r['Rancher Name'] || ''),
      category: String(sel(r['Category']) || 'Other'),
      tier: String(sel(r['Resistance Tier']) || ''),
      price,
      base,
      weight: String(r['Weight / Size'] || ''),
      shelfStable: !!r['Shelf Stable'],
      image: String(r['Image URL'] || ''),
      description: String(r['Description'] || ''),
      depositStyle: r['Deposit Style'] === true,
      priceRange: String(r['Price Range'] || ''),
      ordersLeft:
        r['Orders Left'] === undefined || r['Orders Left'] === null || r['Orders Left'] === ''
          ? null
          : Number(r['Orders Left']),
      whatsIncluded: String(r["What's Included"] || ''),
      shipsInDays: Number(r['Ships In Days']) > 0 ? Number(r['Ships In Days']) : null,
      packaging: String(r['Packaging'] || ''),
      feeds: String(r['Feeds'] || ''),
      rancherId: String(r['Rancher Record ID'] || '').trim(),
      shippingCost: Math.max(0, Number(r['Shipping Cost'] || 0)),
      localOnly: r['Ships Nationwide'] === false,
      externalCheckoutUrl: String(r['External Checkout URL'] || '').trim(),
      rancherState: '',
    },
    soldOut: !hasStock(r),
  };
}

// Browse sections: the 6 Category values collapse into 4 shopper-intent groups.
// Anything with an unmapped Category falls through to "more from the ranch".
export const MARKETPLACE_GROUPS: {
  key: string;
  title: string;
  sub: string;
  categories: string[];
}[] = [
  {
    key: 'jerky',
    title: 'jerky & snack sticks',
    sub: 'shelf-stable · ships anywhere, no freezer needed — the easiest first bite',
    categories: ['Jerky', 'Snack Sticks'],
  },
  {
    key: 'boxes',
    title: 'boxes & bundles',
    sub: 'a mixed box of cuts from one ranch, shipped frozen to your door',
    categories: ['Sampler Box', 'Bundle'],
  },
  {
    key: 'ground',
    title: 'ground beef',
    sub: 'the everyday workhorse — flash-frozen, vacuum-sealed, shipped',
    categories: ['Ground Box'],
  },
  {
    key: 'shares',
    title: 'shares',
    sub: 'a real cut of a whole animal — the best price per pound',
    categories: ['Eighth Share'],
  },
];

/**
 * Funnel picks — the ≤3-product low-ticket rail shown on the /access reveal's
 * NOT-READY outcomes (waitlist / nurture / call), so a buyer who isn't ready
 * for a whole-or-bulk order always has a real, priced next step (Phase 8).
 *
 * Selection: one product per non-share group (jerky → boxes → ground), the
 * cheapest in each; backfill with the next-cheapest non-share products if a
 * group is empty. Shares are EXCLUDED — this rail exists precisely for the
 * buyer who balked at bulk. Pure so it's unit-testable.
 */
export function pickFunnelProducts(products: MarketplaceProduct[]): MarketplaceProduct[] {
  const nonShare = products.filter((p) => !(MARKETPLACE_GROUPS.find((g) => g.key === 'shares')?.categories || []).includes(p.category));
  const picks: MarketplaceProduct[] = [];
  for (const g of MARKETPLACE_GROUPS) {
    if (g.key === 'shares') continue;
    const cheapest = nonShare.find((p) => g.categories.includes(p.category) && !picks.includes(p));
    if (cheapest) picks.push(cheapest);
    if (picks.length >= 3) return picks;
  }
  for (const p of nonShare) {
    if (picks.length >= 3) break;
    if (!picks.includes(p)) picks.push(p);
  }
  return picks;
}

/** Split products into the display groups above, preserving group order. */
export function groupProducts(products: MarketplaceProduct[]): {
  key: string;
  title: string;
  sub: string;
  items: MarketplaceProduct[];
}[] {
  const claimed = new Set<string>();
  const groups = MARKETPLACE_GROUPS.map((g) => {
    const items = products.filter((p) => g.categories.includes(p.category));
    items.forEach((p) => claimed.add(p.id));
    return { key: g.key, title: g.title, sub: g.sub, items };
  }).filter((g) => g.items.length > 0);

  // Any product whose Category isn't in a mapped group still gets shown.
  const leftovers = products.filter((p) => !claimed.has(p.id));
  if (leftovers.length > 0) {
    groups.push({
      key: 'more',
      title: 'more from the ranch',
      sub: 'shipped nationwide',
      items: leftovers,
    });
  }
  return groups;
}
