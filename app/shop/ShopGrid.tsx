'use client';

// ShopGrid — the farmers-market surface (local-first overhaul 2026-07-15).
//
// The old grid was a SKU aisle. A farmers market has a PLACE first ("where's
// your freezer?" at the top; pick a state and the ranches serving it become
// "your local market" ahead of everything else, the rest under "shipped
// nationwide") and FACES second: products group into a stall per ranch —
// cover photo, name, home state, an honest closed-deals badge, a link to
// their page — so the market reads as stalls, not aisles. Category chips +
// price sort still work: they filter/sort WITHIN each stall, and a stall
// with nothing left simply doesn't render.
//
// State resolution order: ?state=XX deep-link (state pages link in) →
// localStorage (remembered pick) → /api/geo soft hint (never persisted).
// No geolocation dependency — the <select> is always the floor.
//
// HONESTY (the non-negotiable): a state with no local supply NEVER shows an
// empty local market — it degrades to "no ranch near you yet" + the REAL
// waitlist count for that state (lib/stateWaitlist → Consumers.State), and
// when counts are unavailable the copy is neutral with no numbers. If the
// ranch-geo join failed upstream (standsGeoKnown false) we claim NOTHING
// local either way.
//
// Client component: picker + chips + sort are interaction; all data arrives
// serialized from the ISR server page (zero client data fetches beyond the
// existing best-effort /api/geo hint).

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import ProductCard from '../components/ProductCard';
import ProductImage from './ProductImage';
import Button from '../components/Button';
import Pill from '../components/Pill';
import { US_STATES, normalizeState, stateName } from '@/lib/states';
import { waitlistLine } from '@/lib/stateSeo';
import {
  splitStandsByState,
  visibleStandProducts,
  standsGeoKnown,
  type ShopStand,
  type StandProduct,
  type StandSort,
} from '@/lib/marketStands';

const SHOP_STATE_KEY = 'bhc-shop-state';

const CHIP_LABELS: Record<string, string> = {
  all: 'all',
  jerky: 'jerky & sticks',
  boxes: 'boxes',
  ground: 'ground beef',
  shares: 'shares',
  more: 'more',
};
// Stable chip order regardless of product price order.
const CHIP_ORDER = ['jerky', 'boxes', 'ground', 'shares', 'more'];

export default function ShopGrid({
  stands,
  waitlistByState,
}: {
  stands: ShopStand[];
  /** per-state waitlist counts; null = unknown → neutral copy, no numbers */
  waitlistByState: Record<string, number> | null;
}) {
  const [active, setActive] = useState<string>('all');
  const [sort, setSort] = useState<StandSort>('price-asc');

  // WHERE'S YOUR FREEZER — deep-link param wins (and persists), then the
  // remembered pick, then the soft IP hint (hint never persists: it's a
  // guess, not a choice).
  const [buyerState, setBuyerState] = useState<string>('');
  useEffect(() => {
    let fromUrl = '';
    try {
      fromUrl = normalizeState(new URLSearchParams(window.location.search).get('state') || '');
    } catch {}
    if (fromUrl) {
      setBuyerState(fromUrl);
      try { localStorage.setItem(SHOP_STATE_KEY, fromUrl); } catch {}
      return;
    }
    let saved = '';
    try { saved = normalizeState(localStorage.getItem(SHOP_STATE_KEY) || ''); } catch {}
    if (saved) { setBuyerState(saved); return; }
    fetch('/api/geo')
      .then((r) => (r.ok ? r.json() : { state: '' }))
      .then((d) => { const st = normalizeState(d?.state || ''); if (st) setBuyerState(st); })
      .catch(() => {});
  }, []);
  const pickState = (raw: string) => {
    const st = normalizeState(raw);
    setBuyerState(st);
    try {
      st ? localStorage.setItem(SHOP_STATE_KEY, st) : localStorage.removeItem(SHOP_STATE_KEY);
    } catch {}
  };

  const st = normalizeState(buyerState);
  const geoKnown = standsGeoKnown(stands);

  // Chips count the nationwide-shippable market (pickup visibility varies by
  // buyer, so counts stay the same honest number for everyone).
  const shipped = useMemo(() => stands.flatMap((s) => s.products), [stands]);
  const chips = useMemo(() => {
    const present = new Set(shipped.map((p) => p.group));
    const keys = [
      'all',
      ...CHIP_ORDER.filter((k) => present.has(k)),
      ...Array.from(present).filter((k) => !CHIP_ORDER.includes(k)),
    ];
    return keys.map((k) => ({
      key: k,
      label: CHIP_LABELS[k] || k,
      count: k === 'all' ? shipped.length : shipped.filter((p) => p.group === k).length,
    }));
  }, [shipped]);

  // Local-first split — only when we have a state AND real ranch geo.
  const { local, nationwide } = useMemo(
    () => (st && geoKnown ? splitStandsByState(stands, st) : { local: [], nationwide: stands }),
    [stands, st, geoKnown],
  );

  // Chip + sort apply WITHIN each stall; a stall the filter empties is
  // hidden. Pickup products only ever surface for same-home-state buyers
  // (inside visibleStandProducts).
  const localStalls = useMemo(
    () =>
      local
        .map((stand) => ({ stand, items: visibleStandProducts(stand, st, active, sort) }))
        .filter((x) => x.items.length > 0),
    [local, st, active, sort],
  );
  const nationwideStalls = useMemo(
    () =>
      nationwide
        .map((stand) => ({ stand, items: visibleStandProducts(stand, st, active, sort) }))
        .filter((x) => x.items.length > 0),
    [nationwide, st, active, sort],
  );

  const stateLabel = st ? stateName(st) : '';
  const waitlist =
    st && waitlistByState && Number(waitlistByState[st]) > 0
      ? waitlistLine(stateLabel, waitlistByState[st])
      : null;

  return (
    <div>
      {/* WHERE'S YOUR FREEZER — the market entrance. A plain select (no
          geolocation dependency); the pick is remembered. */}
      <div className="flex items-center gap-2.5 flex-wrap mb-4">
        <label htmlFor="shop-state" className="text-[13.5px] text-charcoal">
          where&rsquo;s your freezer? <span aria-hidden>🗺️</span>
        </label>
        <select
          id="shop-state"
          value={st}
          onChange={(e) => pickState(e.target.value)}
          className="text-[13px] px-2.5 py-1.5 border border-dust bg-bone text-charcoal focus:outline-none focus:border-charcoal"
        >
          <option value="">pick your state…</option>
          {US_STATES.map((s) => (
            <option key={s.code} value={s.code}>{s.name}</option>
          ))}
        </select>
        {st ? (
          <span className="text-[12px] text-saddle">
            your local market loads first ·{' '}
            <button onClick={() => pickState('')} className="underline hover:text-charcoal transition-colors">
              clear
            </button>
          </span>
        ) : (
          <span className="text-[12px] text-saddle">pick it and your local ranches load first</span>
        )}
      </div>

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
          onChange={(e) => setSort(e.target.value as StandSort)}
          aria-label="Sort products"
          className="shrink-0 text-[12.5px] px-3 py-1.5 border border-dust rounded-full bg-bone text-charcoal focus:outline-none focus:border-charcoal"
        >
          <option value="price-asc">price: low → high</option>
          <option value="price-desc">price: high → low</option>
        </select>
      </div>

      {/* ── YOUR LOCAL MARKET (state picked + geo known) ── */}
      {st && geoKnown && (
        local.length > 0 ? (
          <div className="mt-6">
            <h2 className="font-serif text-xl lowercase">your local market</h2>
            <p className="text-[12.5px] text-saddle mt-0.5">
              ranches serving {stateLabel} — shipped from nearby, pickup where you see it
            </p>
            {localStalls.length > 0 ? (
              <div className="space-y-4 mt-3">
                {localStalls.map(({ stand, items }) => (
                  <RanchStall key={stand.key} stand={stand} items={items} />
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-saddle mt-2">
                nothing local in this section — try another chip above.
              </p>
            )}
          </div>
        ) : (
          /* HONEST EMPTY — never an empty market pretending otherwise. Real
             waitlist count when we have it; neutral copy when we don't.
             "stand" (not "ranch") on purpose: this claims only that no local
             ranch is selling on the market — a state can have a live ranch
             PAGE without a chargeable product, and we don't lie about it. */
          <section className="mt-6 border border-dust bg-bone-warm/60 p-4 md:p-5">
            <div className="font-serif text-lg lowercase">no ranch stand near you yet</div>
            <p className="text-[13.5px] text-saddle mt-1 max-w-[54ch]">
              {waitlist ? `${waitlist} ` : ''}join the {stateLabel} list and you&rsquo;re matched
              first the moment a verified ranch goes live near you.
            </p>
            <div className="mt-3">
              <Button href={`/access?state=${st}`} size="sm">
                join the {stateLabel.toLowerCase()} list →
              </Button>
            </div>
            <p className="text-[12px] text-saddle mt-3 mb-0">
              meanwhile — everything below ships frozen to your door.
            </p>
          </section>
        )
      )}
      {st && !geoKnown && (
        <p className="text-[12.5px] text-saddle mt-4">
          can&rsquo;t sort the market by state right now — everything below ships to you.
        </p>
      )}

      {/* ── SHIPPED NATIONWIDE (the rest of the market — or all of it) ── */}
      {st && geoKnown && local.length > 0 && nationwideStalls.length > 0 && (
        <div className="mt-8">
          <h2 className="font-serif text-xl lowercase">shipped nationwide</h2>
          <p className="text-[12.5px] text-saddle mt-0.5">every other ranch ships frozen to your door</p>
        </div>
      )}
      {nationwideStalls.length > 0 && (
        <div className="space-y-4 mt-4">
          {nationwideStalls.map(({ stand, items }) => (
            <RanchStall key={stand.key} stand={stand} items={items} />
          ))}
        </div>
      )}

      {localStalls.length === 0 && nationwideStalls.length === 0 && (
        <p className="text-center text-saddle py-16 text-sm">
          nothing in this section yet — check back after the next drop.
        </p>
      )}
    </div>
  );
}

/**
 * One ranch stall: the ranch's face (photo, name, home state, honest deal
 * badge, page link) over its products. The deal badge renders only when the
 * count is a real Closed Won number > 0 — never a zero-claim. The page link
 * renders only when the ranch's public page actually resolves (gated slug).
 */
function RanchStall({ stand, items }: { stand: ShopStand; items: StandProduct[] }) {
  return (
    <section className="border border-dust bg-bone-warm/60 p-3.5 md:p-5">
      <div className="flex items-center gap-3 flex-wrap">
        {stand.photo && (
          <div className="h-11 w-11 shrink-0 overflow-hidden bg-bone-deep">
            <ProductImage
              src={stand.photo}
              alt={`${stand.name} ranch`}
              className="w-full h-full object-cover block"
            />
          </div>
        )}
        <div className="flex-1 min-w-[160px]">
          <div className="font-serif text-lg leading-tight">{stand.name}</div>
          <div className="text-[12px] text-saddle mt-0.5">
            {stand.state ? stateName(stand.state) : 'family ranch'}
          </div>
        </div>
        {stand.deals > 0 && (
          <Pill tone="positive">
            {stand.deals} {stand.deals === 1 ? 'deal' : 'deals'} closed
          </Pill>
        )}
        {stand.slug && (
          <Link
            href={`/ranchers/${stand.slug}`}
            className="text-[12.5px] underline text-charcoal hover:text-saddle transition-colors"
          >
            visit the ranch →
          </Link>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-5 mt-3">
        {items.map((p) => (
          <ProductCard key={p.id} p={p} compact />
        ))}
      </div>
    </section>
  );
}
