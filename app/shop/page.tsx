// app/shop/page.tsx
//
// THE MARKETPLACE. The public, ad-destination home for every nationwide-
// shippable product in one clean place. Buyers who balk at a whole share land
// here and buy something small + shipped today.
//
// Browse is organized by CATEGORY (jerky / boxes / ground / shares), not the
// funnel's resistance ladder — this is a cold browse surface, not a warm
// downsell. The half/whole SHARE is pinned at the very top as the anchor: the
// box is a rung UP to it, never a substitute.
//
// ISR (revalidate 300), not force-dynamic: an ad landing page must be fast and
// cacheable, and it caps Airtable reads to ~1 per 5 min instead of one per hit.
// loadMarketplaceProducts() catches its own errors → [], so a build-time
// prerender can never throw.

import Link from 'next/link';
import type { Metadata } from 'next';
import { loadMarketplaceProducts, groupProducts, type MarketplaceProduct } from '@/lib/marketplaceProducts';
import BuyButton from './BuyButton';

export const revalidate = 300;

export const metadata: Metadata = {
  title: 'Shop real ranch beef, shipped nationwide | BuyHalfCow',
  description:
    'Real beef from family ranches, shipped to your door. Jerky, sampler boxes, ground beef bundles, and shares — pick a ranch and stock your freezer.',
  alternates: { canonical: '/shop' },
  openGraph: {
    title: 'Shop real ranch beef, shipped nationwide | BuyHalfCow',
    description: 'Real beef from family ranches, shipped to your door. Jerky, boxes, bundles, and shares.',
    url: '/shop',
    type: 'website',
  },
};

function Card({ p }: { p: MarketplaceProduct }) {
  const href = `/shop/${p.id}`;
  return (
    <div style={{ background: '#fff', border: '1px solid #A7A29A', display: 'flex', flexDirection: 'column' }}>
      <Link href={href} style={{ display: 'block', aspectRatio: '4 / 3', overflow: 'hidden', background: '#EAE6DE' }}>
        {p.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.image} alt={p.name} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#A7A29A', fontFamily: 'Georgia,serif', fontSize: 13 }}>
            BuyHalfCow
          </div>
        )}
      </Link>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        <div>
          <Link href={href} style={{ fontFamily: 'Georgia,serif', fontSize: 18, lineHeight: 1.2, color: '#17130E', textDecoration: 'none' }}>{p.name}</Link>
          <div style={{ fontSize: 12.5, color: '#6B4F3F', marginTop: 2 }}>
            {p.rancher}{p.weight ? ` · ${p.weight}` : ''}
          </div>
        </div>
        {p.description ? (
          <p style={{ fontSize: 13, color: '#3D362D', lineHeight: 1.45, margin: 0 }}>{p.description}</p>
        ) : null}
        <div style={{ fontSize: 12, color: '#55603F' }}>
          {p.shelfStable ? 'shelf-stable · ships anywhere' : 'ships frozen, nationwide'}
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
        <p style={{ color: '#3D362D', fontSize: 17, maxWidth: '54ch', margin: '0 0 8px', lineHeight: 1.5 }}>
          from real family ranches, shipped nationwide. start small — jerky, a box, a bundle — or go all in on a share.
        </p>

        {/* SHARE ANCHOR — pinned at the top. The box is a rung up to this, never a substitute. */}
        <div style={{ background: '#E6E9DC', borderLeft: '3px solid #55603F', padding: '14px 18px', margin: '20px 0 36px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontFamily: 'Georgia,serif', fontSize: 18 }}>going all in? a half or whole share</div>
            <div style={{ fontSize: 13, color: '#3D362D' }}>the best price per pound — a freezer stocked from one animal, one ranch, all year.</div>
          </div>
          <Link href="/map" style={{ padding: '10px 20px', background: '#17130E', color: '#F4F1EC', textDecoration: 'none', fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>
            find a ranch &rarr;
          </Link>
        </div>

        {groups.length === 0 ? (
          <p style={{ color: '#6B4F3F' }}>the shop is stocking up — check back shortly.</p>
        ) : (
          groups.map((group) => (
            <section key={group.key} style={{ marginBottom: 44 }}>
              <div style={{ fontFamily: 'Georgia,serif', fontSize: 25, marginBottom: 2 }}>{group.title}</div>
              <div style={{ fontSize: 13.5, color: '#6B4F3F', marginBottom: 16 }}>{group.sub}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
                {group.items.map((p) => <Card key={p.id} p={p} />)}
              </div>
            </section>
          ))
        )}

        <p style={{ fontSize: 12, color: '#A7A29A', marginTop: 40, borderTop: '1px solid #D8D0C2', paddingTop: 16 }}>
          checkout is secured by Stripe · your beef ships direct from the ranch · questions? reply to your receipt — a real person answers.
        </p>
      </div>
    </main>
  );
}
