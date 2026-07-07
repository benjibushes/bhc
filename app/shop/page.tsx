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
import Container from '../components/Container';
import Card from '../components/Card';
import Button from '../components/Button';
import ProductCard from '../components/ProductCard';
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
  const products = await loadMarketplaceProducts();
  const groups = groupProducts(products);

  return (
    <main className="min-h-screen bg-bone text-charcoal py-16">
      <Container>
        <h1 className="font-serif text-[clamp(30px,6vw,46px)] mb-2 lowercase">
          real beef, shipped to your door
        </h1>
        <p className="text-charcoal/85 text-[17px] max-w-[54ch] mb-1.5 leading-normal">
          you&rsquo;re buying from the family that raised the animal — not a warehouse. start small
          (jerky, a box) or go all in on a share.
        </p>

        {/* Trust strip — honest, non-fabricated, on the exact page ads point at.
            Risk-reversal stated as operational certainty ("we make it right"),
            not support-desk uncertainty — the #1 conversion lever for new-food
            buyers per the journey-overhaul research (Phase 4). */}
        <p className="text-[13.5px] text-sage mt-2.5 mb-7 leading-normal max-w-[60ch]">
          every ranch here is verified — a real family operation.{' '}
          <strong>shipping&rsquo;s included in the price you see.</strong> if a cut ever shows up
          wrong or freezer-burned, we make it right — no forms, no runaround. checkout secured by
          Stripe, and a real person answers your receipt. &mdash; Ben
        </p>

        {/* HOW IT WORKS (Phase 12 — the information gap): the whole store's
            process in one glance, before any product decision. Three plain
            steps, no mystery — every PDP repeats its own product-specific
            version of this. */}
        <div className="flex flex-wrap gap-x-6 gap-y-1.5 mb-8 text-[13px] text-charcoal/80">
          <span><strong className="text-charcoal">1.</strong> pick your beef — every listing says exactly what&rsquo;s in the box</span>
          <span><strong className="text-charcoal">2.</strong> the ranch packs it — vacuum-sealed, shipped frozen (jerky ships shelf-stable)</span>
          <span><strong className="text-charcoal">3.</strong> tracking hits your inbox — it&rsquo;s at your door days later</span>
        </div>

        {groups.length === 0 ? (
          <p className="text-saddle">the shop is stocking up — check back shortly.</p>
        ) : (
          <>
            {/* Category quick-nav — the page's structural spine. One glance =
                the whole store's shape; one tap = the section you came for.
                Anchor links (no JS), scroll-mt on sections clears the sticky
                header. Only shows when there's more than one section. */}
            {groups.length > 1 && (
              <nav aria-label="shop sections" className="flex flex-wrap gap-2 mb-10">
                {groups.map((g) => (
                  <a
                    key={g.key}
                    href={`#${g.key}`}
                    className="px-3.5 py-2 border border-dust text-[13px] text-charcoal hover:bg-charcoal hover:text-bone transition-base"
                  >
                    {g.title} <span className="text-dust">·</span>{' '}
                    <span className="tabular-nums">{g.items.length}</span>
                  </a>
                ))}
              </nav>
            )}

            {groups.map((group) => (
              <section key={group.key} id={group.key} className="mb-12 scroll-mt-24">
                <div className="flex items-baseline justify-between gap-3 border-b border-dust pb-2 mb-1">
                  <h2 className="font-serif text-2xl lowercase">{group.title}</h2>
                  <span className="text-xs text-dust tabular-nums shrink-0">
                    {group.items.length} {group.items.length === 1 ? 'product' : 'products'}
                  </span>
                </div>
                <div className="text-[13.5px] text-saddle mb-4">{group.sub}</div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
                  {group.items.map((p) => (
                    <ProductCard key={p.id} p={p} />
                  ))}
                </div>
              </section>
            ))}

            {/* SHARE ANCHOR — last, as the graduation. De-emphasized (secondary
                Button) so the product Buy buttons stay the loudest thing on the
                page. Box is a rung UP toward the share, never a substitute. */}
            <Card
              variant="warm"
              padding="sm"
              className="border-l-2 border-l-sage mt-2 flex items-center gap-4 flex-wrap"
            >
              <div className="flex-1 min-w-[220px]">
                <div className="font-serif text-lg">ready to go all in? a half or whole share</div>
                <div className="text-[13px] text-charcoal/80">
                  the best price per pound — a freezer stocked from one animal, one ranch, all year.
                </div>
              </div>
              <Button href="/map" variant="secondary" size="sm">
                find a ranch &rarr;
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
