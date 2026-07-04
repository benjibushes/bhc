'use client';

// app/components/GearBlock.tsx
//
// Renders a small titled grid of curated affiliate products with the FTC
// disclosure beneath. The core of the AFFILIATE-PRODUCTS LAYER's web surface.
//
// Two ways to feed it:
//   1. `products` prop — caller already has the selected list (server-fed, or
//      pre-fetched). Rendered as-is.
//   2. `stage` (+ optional `cut`) with NO products prop — the block fetches
//      /api/gear?stage=&cut= itself (for client-only trees like /member that
//      can't pass server props). Selection still happens server-side.
//
// CRITICAL: renders NOTHING (null) when there are no products — an empty
// catalog (today's reality — Ben adds products later) must look clean, never a
// dead block. Each "shop →" link routes through /go/product/<id> so the click
// is logged + attributed before the outbound affiliate redirect.
//
// Styling matches the checkout/rancher palette already in the repo:
// bone / charcoal / saddle / dust, font-serif headings, uppercase-tracked CTAs.

import { useEffect, useState } from 'react';
import AffiliateDisclosure from './AffiliateDisclosure';

export interface GearBlockProduct {
  id: string;
  Name: string;
  Category?: string;
  'Affiliate URL'?: string;
  Network?: string;
  'Image URL'?: string;
  Blurb?: string;
}

interface GearBlockProps {
  stage: 'waiting' | 'delivered';
  // Server-fed / pre-selected products. When provided, the block does NOT fetch.
  products?: GearBlockProduct[];
  // Buyer's cut — only used for the self-fetch path. Ignored when `products` is set.
  cut?: 'quarter' | 'half' | 'whole' | null;
  // Attribution threaded into the /go/product click-log query string.
  buyerId?: string;
  refId?: string;
  // Which placement is rendering this — logged as Surface on the click.
  surface: 'success' | 'member' | 'gear';
  // Optional heading override; otherwise derived from stage.
  heading?: string;
}

const STAGE_HEADINGS: Record<'waiting' | 'delivered', string> = {
  waiting: "while you wait, here's what you'll want",
  delivered: 'keep your beef at its best',
};

export default function GearBlock({
  stage,
  products,
  cut = null,
  buyerId = '',
  refId = '',
  surface,
  heading,
}: GearBlockProps) {
  // Self-fetch path: only when the caller didn't hand us products.
  const [fetched, setFetched] = useState<GearBlockProduct[] | null>(
    products ? null : null,
  );

  useEffect(() => {
    if (products) return; // server-fed — never fetch
    let alive = true;
    const qs = new URLSearchParams({ stage });
    if (cut) qs.set('cut', cut);
    fetch(`/api/gear?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : { products: [] }))
      .then((j) => {
        if (alive) setFetched(Array.isArray(j?.products) ? j.products : []);
      })
      .catch(() => {
        if (alive) setFetched([]); // fail closed → renders nothing
      });
    return () => {
      alive = false;
    };
  }, [products, stage, cut]);

  const list = products ?? fetched ?? [];

  // Empty catalog (or still loading the self-fetch) → render nothing. No dead
  // block, no skeleton — the surface should look clean with zero products.
  if (list.length === 0) return null;

  const title = heading || STAGE_HEADINGS[stage];

  const goHref = (p: GearBlockProduct) => {
    const qs = new URLSearchParams({ surface });
    if (buyerId) qs.set('buyer', buyerId);
    if (refId) qs.set('ref', refId);
    return `/go/product/${p.id}?${qs.toString()}`;
  };

  return (
    <section className="bg-white border border-dust p-4 md:p-6" aria-label="Gear we trust">
      <h2 className="font-serif text-lg md:text-xl mb-1 text-charcoal">{title}</h2>
      <p className="text-sm text-saddle mb-4">gear we&rsquo;d put in our own freezer.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {list.map((p) => (
          <div key={p.id} className="flex gap-3 border border-dust bg-bone p-3">
            {p['Image URL'] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={p['Image URL']}
                alt={p.Name}
                loading="lazy"
                className="w-16 h-16 object-cover border border-dust flex-shrink-0 bg-white"
              />
            ) : null}
            <div className="min-w-0 flex flex-col">
              <p className="font-medium text-sm text-charcoal truncate">{p.Name}</p>
              {p.Blurb ? (
                <p className="text-xs text-saddle mt-0.5 line-clamp-3">{p.Blurb}</p>
              ) : null}
              <a
                href={goHref(p)}
                target="_blank"
                rel="nofollow sponsored noopener noreferrer"
                className="mt-auto pt-2 text-xs uppercase tracking-wider text-charcoal hover:text-saddle font-medium"
              >
                shop &rarr;
              </a>
            </div>
          </div>
        ))}
      </div>
      <AffiliateDisclosure className="mt-4" />
    </section>
  );
}
