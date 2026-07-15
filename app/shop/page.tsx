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
import { loadMarketplaceProducts, groupKeyForCategory } from '@/lib/marketplaceProducts';
import { buildShopStands, type MarketProductInput } from '@/lib/marketStands';
import { getSocialProofStats } from '@/lib/socialProof';
import { getWaitlistCountsByState } from '@/lib/stateWaitlist';
import { getLiveShareRanchCountsByState } from '@/lib/stateSupply';
import Container from '../components/Container';
import Card from '../components/Card';
import Button from '../components/Button';
import ShopGrid from './ShopGrid';
import TrustStrip from '../components/TrustStrip';
import ProofStrip from '../components/ProofStrip';

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
  // LOCAL MARKET (2026-07-15): the market reads as ranch stands, local-first.
  // includeLocal pulls pickup-only products too — they render ONLY inside
  // their home-state ranch's stall for a same-state buyer (the TX-buyer-
  // never-sees-an-MT-pickup invariant, enforced in lib/marketStands). ISR
  // stays intact: the full (small) set ships in the payload and the client
  // reorders it around the buyer's state. The two proof reads are best-
  // effort + lib-cached: socialProof (same 5-min cache ProofStrip shares —
  // no extra Airtable read) and the per-state waitlist counts for the
  // honest-empty fallback (null = unknown → neutral copy, no numbers).
  const [all, proofStats, waitlistByState, shareRanchesByState] = await Promise.all([
    loadMarketplaceProducts({ includeLocal: true, withStates: true }),
    getSocialProofStats(),
    getWaitlistCountsByState(),
    // Live share-ranch counts (lib/stateSupply, same visibility filter as
    // /half-a-cow/[state]) — powers the honest-empty cross-link: a state
    // with no ranch STAND but live share-ranches points buyers at shares
    // instead of contradicting the state page. Rides the Ranchers table
    // cache; null = unknown → no cross-link, never a wrong claim.
    getLiveShareRanchCountsByState(),
  ]);
  // A ranch that can't take a direct charge yet (Connect != active) never
  // lists on /shop — the buy route would 409 and dead-end the buyer.
  const chargeable = all.filter((p) => p.rancherConnectActive !== false);
  const products = chargeable.filter((p) => !p.localOnly);
  // Serialize for the client market (ShopGrid can't import
  // lib/marketplaceProducts — it's server-only): every product gets its
  // browse-group key + the ranch-stand metadata the stalls render.
  const flat: MarketProductInput[] = chargeable.map((p) => ({
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
    group: groupKeyForCategory(p.category),
    localOnly: p.localOnly,
    rancherId: p.rancherId,
    rancherState: p.rancherState,
    rancherServesStates: p.rancherServesStates,
    rancherSlug: p.rancherSlug,
    rancherPhoto: p.rancherPhoto,
  }));
  const stands = buildShopStands(flat, proofStats?.dealsByRancher || {});

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
          <span className="text-xs text-dust tabular-nums">{products.length} products · {stands.length} ranch {stands.length === 1 ? 'stand' : 'stands'}</span>
        </div>
        <p className="text-charcoal/85 text-[15px] max-w-[58ch] leading-normal mb-2">
          real beef from the family that raised it — shipped frozen to your door.
          full cost on every card: shipping&rsquo;s included or shown up front, never a
          checkout surprise.
        </p>
        <p className="text-[12.5px] text-sage mb-4">
          verified ranches · secured by stripe · wrong or freezer-burned? we make it right — no forms. &mdash; Ben
        </p>
        {/* Social proof under the hero — live Closed Won aggregates (trust gap
            2026-07-14: real wins rendered only on /wins). Renders nothing when
            Airtable is unavailable — never a zero-claim on the money page.
            Negative top margin tucks it under the trust line; when the strip
            doesn't render the layout is byte-identical to before. */}
        <ProofStrip className="-mt-2.5 mb-4" />

        {stands.length === 0 ? (
          <p className="text-saddle">the shop is stocking up — check back shortly.</p>
        ) : (
          <>
            <ShopGrid
              stands={stands}
              waitlistByState={waitlistByState}
              shareRanchesByState={shareRanchesByState}
            />

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
