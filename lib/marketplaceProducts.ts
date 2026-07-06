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

import { getAllRecords, TABLES } from '@/lib/airtable';

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
    base <= price
  );
}

/** Load every sellable nationwide-shippable product, cheapest first. */
export async function loadMarketplaceProducts(): Promise<MarketplaceProduct[]> {
  let rows: any[] = [];
  try {
    rows = (await getAllRecords(TABLES.RANCHER_PRODUCTS)) as any[];
  } catch {
    return [];
  }
  return rows
    .filter(isSellableRow)
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
    }))
    .sort((a, b) => a.price - b.price);
}

/** Load one product by record id — returns null if missing or not sellable. */
export async function loadMarketplaceProduct(id: string): Promise<MarketplaceProduct | null> {
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) return null;
  const all = await loadMarketplaceProducts();
  return all.find((p) => p.id === id) || null;
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
