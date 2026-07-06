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
// ISR (revalidate 300): fast, cacheable ad LP; ~1 Airtable read / 5 min.
// loadMarketplaceProducts() catches its own errors → [], so a prerender can't throw.

import Link from 'next/link';
import type { Metadata } from 'next';
import { loadMarketplaceProducts, groupProducts, type MarketplaceProduct } from '@/lib/marketplaceProducts';
import BuyButton from './BuyButton';
import ProductImage from './ProductImage';

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

function Card({ p }: { p: MarketplaceProduct }) {
  const href = `/shop/${p.id}`;
  return (
    <div style={{ background: '#fff', border: '1px solid #A7A29A', display: 'flex', flexDirection: 'column' }}>
      <Link href={href} style={{ display: 'block', aspectRatio: '4 / 3', overflow: 'hidden', background: '#EAE6DE' }}>
        <ProductImage src={p.image} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      </Link>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        <div>
          <Link href={href} style={{ fontFamily: 'Georgia,serif', fontSize: 18, lineHeight: 1.2, color: '#17130E', textDecoration: 'none' }}>{p.name}</Link>
          <div style={{ fontSize: 12.5, color: '#6B4F3F', marginTop: 2 }}>
            {p.rancher}{p.weight ? ` · ${p.weight}` : ''}
          </div>
        </div>
        {/* Standalone, scannable price at name level (not only inside the CTA). */}
        <div style={{ fontFamily: 'Georgia,serif', fontSize: 20 }}>${p.price.toFixed(2)}</div>
        {p.description ? (
          <p style={{ fontSize: 13, color: '#3D362D', lineHeight: 1.45, margin: 0 }}>{p.description}</p>
        ) : null}
        <div style={{ fontSize: 12, color: '#55603F' }}>
          {p.shelfStable ? 'shelf-stable · ships free, no freezer needed' : 'ships frozen · shipping included'}
        </div>
        <div style={{ marginTop: 'auto', paddingTop: 4 }}>
          <BuyButton productId={p.id} price={p.price} />
        </div>
      </div>
    </div>
  );
}

export default async function MarketplacePage() {
  const products = await loadMarketplaceProducts();
  const groups = groupProducts(products);

  return (
    <main style={{ background: '#F4F1EC', minHeight: '100vh', padding: '48px 20px', fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif', color: '#17130E' }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 'clamp(30px,6vw,46px)', margin: '0 0 8px' }}>real beef, shipped to your door</h1>
        <p style={{ color: '#3D362D', fontSize: 17, maxWidth: '54ch', margin: '0 0 6px', lineHeight: 1.5 }}>
          you&rsquo;re buying from the family that raised the animal — not a warehouse. start small (jerky, a box) or go all in on a share.
        </p>

        {/* Trust strip — honest, non-fabricated, on the exact page ads point at. */}
        <p style={{ fontSize: 13.5, color: '#55603F', margin: '10px 0 28px', lineHeight: 1.5, maxWidth: '60ch' }}>
          every ranch here is verified — a real family operation. <strong>shipping&rsquo;s included in the price you see.</strong> checkout secured by Stripe, and a real person answers your receipt. &mdash; Ben
        </p>

        {groups.length === 0 ? (
          <p style={{ color: '#6B4F3F' }}>the shop is stocking up — check back shortly.</p>
        ) : (
          <>
            {groups.map((group) => (
              <section key={group.key} style={{ marginBottom: 44 }}>
                <div style={{ fontFamily: 'Georgia,serif', fontSize: 25, marginBottom: 2 }}>{group.title}</div>
                <div style={{ fontSize: 13.5, color: '#6B4F3F', marginBottom: 16 }}>{group.sub}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
                  {group.items.map((p) => <Card key={p.id} p={p} />)}
                </div>
              </section>
            ))}

            {/* SHARE ANCHOR — last, as the graduation. De-emphasized (outline CTA)
                so the product Buy buttons stay the loudest thing on the page. */}
            <div style={{ background: '#E6E9DC', borderLeft: '3px solid #55603F', padding: '16px 18px', marginTop: 8, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontFamily: 'Georgia,serif', fontSize: 18 }}>ready to go all in? a half or whole share</div>
                <div style={{ fontSize: 13, color: '#3D362D' }}>the best price per pound — a freezer stocked from one animal, one ranch, all year.</div>
              </div>
              <Link href="/map" style={{ padding: '9px 18px', background: 'transparent', color: '#17130E', textDecoration: 'none', fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', border: '1.5px solid #55603F' }}>
                find a ranch &rarr;
              </Link>
            </div>
          </>
        )}

        <p style={{ fontSize: 12, color: '#A7A29A', marginTop: 40, borderTop: '1px solid #D8D0C2', paddingTop: 16 }}>
          checkout is secured by Stripe · your beef ships direct from the ranch · questions? reply to your receipt — a real person answers.
        </p>
      </div>
    </main>
  );
}
