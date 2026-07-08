// app/shop/page.tsx
//
// THE MARKETPLACE. The public, ad-destination home for every nationwide-
// shippable product in one clean place. Buyers who balk at a whole share land
// here and buy something small + shipped today.
//
// Layout order is conversion-first (CRO 2026-07-06): headline → why-a-ranch →
// trust strip → PRODUCTS (a buyable card lands in the first mobile viewport) →
// the share anchor LAST as the graduation (a rung UP, de-emphasized so the buy
// buttons stay the loudest CTA on the page). Browse by CATEGORY, not the funnel
// ladder — this is a cold browse surface, not a warm downsell.
//
// Styled on the brand system (Phase 3 migration): tokens + Container +
// ProductCard/PriceTag/TrustStrip — diffable against /gear (the browse-surface
// reference). Section rhythm py-16 to inherit the site's editorial calm.
//
// ISR (revalidate 300): fast, cacheable ad LP; ~1 Airtable read / 5 min.
// loadMarketplaceProducts() catches its own errors → [], so a prerender can't throw.

import Link from 'next/link';
import type { Metadata } from 'next';
import { loadMarketplaceProducts, groupProducts } from '@/lib/marketplaceProducts';
import type { LocalMarketProduct } from './ShopGrid';
import Container from '../components/Container';
import Card from '../components/Card';
import Button from '../components/Button';
import ShopGrid from './ShopGrid';
import TrustStrip from '../components/TrustStrip';

export const revalidate = 300;

const TITLE = 'Shop real ranch beef, shipped nationwide';
const DESC = 'Real beef from family ranches, shipped to your door. Jerky, sampler boxes, ground beef bundles, and shares — pick a ranch and stock your freezer. Shipping included.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESC,
  alternates: { canonical: '/shop' },
  openGraph: { title: `${TITLE} | BuyHalfCow`, description: DESC, url: '/shop', type: 'website' },
  twitter: { card: 'summary_large_image', title: `${TITLE} | BuyHalfCow`, description: DESC },
};

export default async function MarketplacePage() {
  // FARMERS MARKET (2026-07-08): includeLocal pulls pickup-only products too.
  // They are split OUT of the nationwide grid below and rendered only in the
  // location-matched "near you" rail — a TX buyer still never sees an MT
  // pickup product. ISR stays intact: the full (small) set ships in the
  // payload and the client matches it to the buyer's state.
  const all = await loadMarketplaceProducts({ includeLocal: true });
  const products = all.filter((p) => !p.localOnly);
  const localProducts: LocalMarketProduct[] = all
    .filter((p) => p.localOnly && p.rancherState)
    .map((p) => ({
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
      localOnly: true,
      rancherState: p.rancherState,
    }));
  const groups = groupProducts(products);
  // Flatten group membership onto each product for the client grid's chips
  // (ShopGrid can't import lib/marketplaceProducts — it's server-only).
  const gridProducts = groups.flatMap((g) =>
    g.items.map((p) => ({
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
      group: g.key,
    })),
  );

  return (
    <main className="min-h-screen bg-bone text-charcoal py-10 md:py-14">
      <Container>
        {/* MARKETPLACE REDESIGN (founder 2026-07-08): the old page was
            editorial — one giant card per row, four section headers, ~8k px
            of mobile scroll for ten products, two viewports of copy before
            the first price. A marketplace browses: compact header, ONE trust
            line, sticky chips + sort, 2-up/4-up grid, products above the
            fold. The long-form trust + how-it-works copy lives on every PDP
            where the buying decision actually happens. */}
        <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
          <h1 className="font-serif text-[clamp(26px,5vw,40px)] lowercase">shop the ranches</h1>
          <span className="text-xs text-dust tabular-nums">{products.length} products · {new Set(products.map((p) => p.rancher)).size} ranches</span>
        </div>
        <p className="text-charcoal/85 text-[15px] max-w-[58ch] leading-normal mb-2">
          real beef from the family that raised it — shipped frozen to your door.
          full cost on every card: shipping&rsquo;s included or shown up front, never a
          checkout surprise.
        </p>
        <p className="text-[12.5px] text-sage mb-4">
          verified ranches · secured by stripe · wrong or freezer-burned? we make it right — no forms. &mdash; Ben
        </p>

        {gridProducts.length === 0 ? (
          <p className="text-saddle">the shop is stocking up — check back shortly.</p>
        ) : (
          <>
            <ShopGrid products={gridProducts} localProducts={localProducts} />

            {/* SHARE ANCHOR — last, as the graduation. De-emphasized (secondary
                Button) so the product Buy buttons stay the loudest thing on the
                page. Box is a rung UP toward the share, never a substitute. */}
            <Card
              variant="warm"
              padding="sm"
              className="border-l-2 border-l-sage mt-2 flex items-center gap-4 flex-wrap"
            >
              <div className="flex-1 min-w-[220px]">
                <div className="font-serif text-lg">ready to go all in? reserve a share</div>
                <div className="text-[13px] text-charcoal/80">
                  the best price per pound, from the ranch nearest you — deposit fully
                  refundable until your rancher accepts.
                </div>
              </div>
              <Button href="/access" variant="secondary" size="sm">
                reserve your share &rarr;
              </Button>
            </Card>
          </>
        )}

        <p className="text-[13.5px] text-saddle mt-9 text-center">
          <Link href="/gear" className="underline hover:text-charcoal transition-colors">
            ben&rsquo;s gear — the stuff i use to store, cut &amp; cook it &rarr;
          </Link>
        </p>

        <div className="mt-6 border-t border-dust pt-4">
          <TrustStrip className="text-xs" />

          {/* Capture-leak patch (2026-07-06 journey map): a browse-and-bounce
              visitor used to leave with nothing captured. One quiet line —
              /guide does the actual capture (email+SMS). */}
          <p className="text-[13px] text-saddle mt-4">
            still deciding?{' '}
            <a href="/guide" className="underline hover:text-charcoal transition-colors">
              get the free guide — what a half cow actually costs &rarr;
            </a>
          </p>
        </div>
      </Container>
    </main>
  );
}
