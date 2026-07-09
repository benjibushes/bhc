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

import { useEffect, useMemo, useState } from 'react';
import ProductCard, { type ProductCardProduct } from '../components/ProductCard';
import { US_STATES, normalizeState } from '@/lib/states';

export interface ShopGridProduct extends ProductCardProduct {
  /** browse-group key precomputed server-side (client can't import lib/marketplaceProducts) */
  group: string;
}

/** Pickup-only product + its ranch's state, for the farmers-market rail. */
export interface LocalMarketProduct extends ProductCardProduct {
  rancherState: string;
}

const SHOP_STATE_KEY = 'bhc-shop-state';

const CHIP_LABELS: Record<string, string> = {
  all: 'all',
  jerky: 'jerky & sticks',
  boxes: 'boxes',
  ground: 'ground beef',
  shares: 'shares',
  more: 'more',
};

type SortKey = 'price-asc' | 'price-desc';

export default function ShopGrid({
  products,
  localProducts = [],
}: {
  products: ShopGridProduct[];
  localProducts?: LocalMarketProduct[];
}) {
  const [active, setActive] = useState<string>('all');
  const [sort, setSort] = useState<SortKey>('price-asc');

  // FARMERS MARKET — buyer state: manual pick (localStorage) wins, IP-geo
  // hint fills the first visit. '' = unknown → rail hidden, grid unaffected.
  const [buyerState, setBuyerState] = useState<string>('');
  useEffect(() => {
    if (localProducts.length === 0) return;
    let saved = '';
    try { saved = localStorage.getItem(SHOP_STATE_KEY) || ''; } catch {}
    if (saved) { setBuyerState(saved); return; }
    fetch('/api/geo')
      .then((r) => (r.ok ? r.json() : { state: '' }))
      .then((d) => { if (d?.state) setBuyerState(String(d.state)); })
      .catch(() => {});
  }, [localProducts.length]);
  const pickState = (st: string) => {
    setBuyerState(st);
    try { st ? localStorage.setItem(SHOP_STATE_KEY, st) : localStorage.removeItem(SHOP_STATE_KEY); } catch {}
  };
  const nearYou = useMemo(() => {
    const st = normalizeState(buyerState);
    if (!st) return [];
    return localProducts.filter((p) => p.rancherState === st);
  }, [localProducts, buyerState]);
  const marketStates = useMemo(
    () => Array.from(new Set(localProducts.map((p) => p.rancherState))).sort(),
    [localProducts],
  );

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
            className={`shrink-0 px-3.5 py-1.5 text-[12.5px] border rounded-full transition-base ${
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
          className="shrink-0 text-[12.5px] px-3 py-1.5 border border-dust rounded-full bg-bone text-charcoal focus:outline-none focus:border-charcoal"
        >
          <option value="price-asc">price: low → high</option>
          <option value="price-desc">price: high → low</option>
        </select>
      </div>

      {/* FARMERS MARKET — pickup products from ranches in the buyer's state.
          Renders only when local products exist AND the buyer's state matches
          at least one (a TX buyer never sees an MT pickup product). The state
          select doubles as the manual override for the IP guess. */}
      {localProducts.length > 0 && (
        <section className="mt-5 border border-dust bg-bone-deep/40 p-3.5">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div className="font-serif text-lg lowercase">
              🧺 the farmers market{' '}
              <span className="text-[12.5px] text-saddle font-sans">
                — pickup at the ranch, no shipping
              </span>
            </div>
            <label className="text-[12.5px] text-charcoal flex items-center gap-1.5">
              your state
              <select
                value={normalizeState(buyerState) || ''}
                onChange={(e) => pickState(e.target.value)}
                className="text-[12.5px] px-1.5 py-1 border border-dust bg-bone focus:outline-none focus:border-charcoal"
              >
                <option value="">pick…</option>
                {US_STATES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code}{marketStates.includes(s.code) ? ' ·🧺' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {nearYou.length > 0 ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-5 mt-3">
              {nearYou.map((p) => (
                <ProductCard key={p.id} p={p} compact />
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-saddle mt-2 mb-0">
              {normalizeState(buyerState)
                ? `no ranch pickup in ${normalizeState(buyerState)} yet — everything below ships to you.`
                : `pick your state to see ranch-pickup products near you (currently in ${marketStates.join(', ')}).`}
            </p>
          )}
        </section>
      )}

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
