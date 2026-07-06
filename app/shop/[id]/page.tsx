// app/shop/[id]/page.tsx
//
// Product detail page (PDP). One product, the full story: hero photo, what's in
// the box, price, ships note, Buy. Three jobs:
//   1. Give every product a shareable URL (/shop/<id>) an ad can point straight at.
//   2. Show the photo + "what's in the box" — the #1 low-ticket buy-driver.
//   3. Emit Product JSON-LD so the product is eligible for rich results + is
//      legible to AI crawlers.
// The Buy path stays one tap (same public buy endpoint); the detail is the lift.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getRecordById, TABLES } from '@/lib/airtable';

import BuyButton from '../BuyButton';
import ProductViewTracker from './ProductViewTracker';

export const revalidate = 300;

const SITE_URL = 'https://www.buyhalfcow.com';

interface Prod {
  id: string;
  name: string;
  rancher: string;
  category: string;
  price: number;
  base: number;
  weight: string;
  shelfStable: boolean;
  image: string;
  description: string;
}

const sel = (v: any) => (v && typeof v === 'object' ? v.name : v) || '';

// Only a SELLABLE product gets a page — same rule as the marketplace grid:
// Active + Ships Nationwide + priced with a non-negative margin. Anything else
// returns null → notFound().
async function loadProduct(id: string): Promise<Prod | null> {
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) return null;
  let r: any;
  try {
    r = await getRecordById(TABLES.RANCHER_PRODUCTS, id);
  } catch {
    return null;
  }
  if (!r) return null;
  const price = Number(r['Display Price'] || 0);
  const base = Number(r['Rancher Base'] || 0);
  const sellable =
    r['Active'] === true &&
    r['Ships Nationwide'] !== false &&
    price > 0 &&
    base > 0 &&
    base <= price;
  if (!sellable) return null;
  return {
    id: r.id,
    name: String(r['Product Name'] || ''),
    rancher: String(r['Rancher Name'] || ''),
    category: String(sel(r['Category']) || ''),
    price,
    base,
    weight: String(r['Weight / Size'] || ''),
    shelfStable: !!r['Shelf Stable'],
    image: String(r['Image URL'] || ''),
    description: String(r['Description'] || ''),
  };
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const p = await loadProduct(id);
  if (!p) return { title: 'Shop real ranch beef, shipped nationwide | BuyHalfCow' };
  const title = `${p.name} — ${p.rancher} | BuyHalfCow`;
  const description = p.description || 'Real beef, shipped to your door from a family ranch.';
  return {
    title,
    description,
    alternates: { canonical: `/shop/${p.id}` },
    openGraph: {
      title,
      description,
      url: `/shop/${p.id}`,
      images: p.image ? [{ url: p.image }] : [],
    },
  };
}

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await loadProduct(id);
  if (!p) notFound();

  // Product JSON-LD — only when an image + price exist (Google requires image).
  const jsonLd =
    p.image && p.price > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: p.name,
          image: [p.image],
          ...(p.description ? { description: p.description } : {}),
          ...(p.category ? { category: p.category } : {}),
          brand: { '@type': 'Brand', name: p.rancher },
          offers: {
            '@type': 'Offer',
            price: p.price.toFixed(2),
            priceCurrency: 'USD',
            availability: 'https://schema.org/InStock',
            url: `${SITE_URL}/shop/${p.id}`,
          },
        }
      : null;

  return (
    <main style={{ background: '#F4F1EC', minHeight: '100vh', padding: '32px 20px 56px', fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif', color: '#17130E' }}>
      {jsonLd ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      ) : null}
      <ProductViewTracker productId={p.id} name={p.name} price={p.price} />

      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        <Link href="/shop" style={{ fontSize: 13.5, color: '#6B4F3F', textDecoration: 'none' }}>&larr; all products</Link>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 28, marginTop: 18, alignItems: 'start' }}>
          {/* Photo */}
          <div style={{ background: '#EAE6DE', border: '1px solid #A7A29A', aspectRatio: '1 / 1', overflow: 'hidden' }}>
            {p.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.image} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            ) : (
              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#A7A29A', fontSize: 13 }}>
                photo coming soon
              </div>
            )}
          </div>

          {/* Story + Buy */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 'clamp(26px,5vw,34px)', margin: '0 0 4px', lineHeight: 1.15 }}>{p.name}</h1>
              <div style={{ fontSize: 14, color: '#6B4F3F' }}>
                {p.rancher}{p.weight ? ` · ${p.weight}` : ''}
              </div>
            </div>

            <div style={{ fontFamily: 'Georgia,serif', fontSize: 26 }}>${p.price.toFixed(2)}</div>

            {p.description ? (
              <p style={{ fontSize: 15.5, color: '#3D362D', lineHeight: 1.55, margin: 0 }}>{p.description}</p>
            ) : null}

            <div style={{ fontSize: 13, color: '#55603F' }}>
              {p.shelfStable ? 'shelf-stable · ships anywhere, no freezer needed' : 'ships frozen, direct from the ranch · nationwide'}
            </div>

            <div style={{ marginTop: 4 }}>
              <BuyButton productId={p.id} price={p.price} />
            </div>

            <p style={{ fontSize: 12, color: '#A7A29A', margin: '2px 0 0', lineHeight: 1.5 }}>
              checkout secured by Stripe · shipping calculated at checkout where it applies · questions? reply to your receipt — a real person answers.
            </p>
          </div>
        </div>

        {/* Anchor on the share — the box is a rung, not a substitute. */}
        <div style={{ background: '#E6E9DC', borderLeft: '3px solid #55603F', padding: '14px 18px', marginTop: 36, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontFamily: 'Georgia,serif', fontSize: 17 }}>ready for a freezer-fill?</div>
            <div style={{ fontSize: 13, color: '#3D362D' }}>a half or whole share is the best price per pound — one animal, one ranch, all year.</div>
          </div>
          <Link href="/map" style={{ padding: '10px 20px', background: '#17130E', color: '#F4F1EC', textDecoration: 'none', fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>
            find a ranch &rarr;
          </Link>
        </div>
      </div>
    </main>
  );
}
