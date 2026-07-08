'use client';

// ShopGrid — the marketplace surface (founder redesign 2026-07-08).
//
// The old /shop was editorial: one giant card per row, four section headers,
// ~8k px of mobile scroll for ten products. A marketplace browses: sticky
// category chips + a price sort over a 2-up (mobile) / 4-up (desktop) grid
// of compact cards, products inside the first viewport.
//
// Client component: chips + sort are interaction; the product data arrives
// serialized from the ISR server page (zero client fetches — still fast).

import { useMemo, useState } from 'react';
import ProductCard, { type ProductCardProduct } from '../components/ProductCard';

export interface ShopGridProduct extends ProductCardProduct {
  /** browse-group key precomputed server-side (client can't import lib/marketplaceProducts) */
  group: string;
}

const CHIP_LABELS: Record<string, string> = {
  all: 'all',
  jerky: 'jerky & sticks',
  boxes: 'boxes',
  ground: 'ground beef',
  shares: 'shares',
  more: 'more',
};

type SortKey = 'price-asc' | 'price-desc';

export default function ShopGrid({ products }: { products: ShopGridProduct[] }) {
  const [active, setActive] = useState<string>('all');
  const [sort, setSort] = useState<SortKey>('price-asc');

  const chips = useMemo(() => {
    const keys = ['all', ...Array.from(new Set(products.map((p) => p.group)))];
    return keys.map((k) => ({
      key: k,
      label: CHIP_LABELS[k] || k,
      count: k === 'all' ? products.length : products.filter((p) => p.group === k).length,
    }));
  }, [products]);

  const visible = useMemo(() => {
    const filtered = active === 'all' ? products : products.filter((p) => p.group === active);
    return [...filtered].sort((a, b) => (sort === 'price-asc' ? a.price - b.price : b.price - a.price));
  }, [products, active, sort]);

  return (
    <div>
      {/* Sticky browse bar — chips left, sort right. Sticks under the page
          header so filtering never requires a scroll back up. */}
      <div className="sticky top-0 z-20 -mx-4 px-4 py-2.5 bg-bone/95 backdrop-blur-sm border-b border-dust flex items-center gap-2 overflow-x-auto">
        {chips.map((c) => (
          <button
            key={c.key}
            onClick={() => setActive(c.key)}
            className={`shrink-0 px-3 py-1.5 text-[12.5px] border transition-base ${
              active === c.key
                ? 'bg-charcoal text-bone border-charcoal'
                : 'bg-bone text-charcoal border-dust hover:border-charcoal'
            }`}
          >
            {c.label} <span className={active === c.key ? 'text-bone/60' : 'text-dust'}>{c.count}</span>
          </button>
        ))}
        <span className="flex-1" />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Sort products"
          className="shrink-0 text-[12.5px] px-2 py-1.5 border border-dust bg-bone text-charcoal focus:outline-none focus:border-charcoal"
        >
          <option value="price-asc">price: low → high</option>
          <option value="price-desc">price: high → low</option>
        </select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-5 mt-5">
        {visible.map((p) => (
          <ProductCard key={p.id} p={p} compact />
        ))}
      </div>

      {visible.length === 0 && (
        <p className="text-center text-saddle py-16 text-sm">nothing in this section yet — check back after the next drop.</p>
      )}
    </div>
  );
}
