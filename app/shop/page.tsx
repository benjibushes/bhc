// app/shop/page.tsx
//
// The self-serve storefront. Products listed → Buy → straight to Stripe. Fast,
// simple, easy. Server-rendered: reads the Active Rancher Products catalog and
// renders the 3-rung ladder (research: anchor on the share, box/jerky are the
// rungs that catch balkers). Each card's Buy button hits the public checkout.

import Link from 'next/link';
import { getAllRecords, TABLES } from '@/lib/airtable';
import BuyButton from './BuyButton';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'shop — real beef, shipped to your door | BuyHalfCow',
  description: 'Try a ranch before your freezer-fill. Jerky, sampler boxes, and beef bundles from real family ranches, shipped nationwide.',
};

interface Prod {
  id: string;
  name: string;
  rancher: string;
  tier: string;
  price: number;
  base: number;
  weight: string;
  shelfStable: boolean;
}

const sel = (v: any) => (v && typeof v === 'object' ? v.name : v) || '';

async function loadProducts(): Promise<Prod[]> {
  let rows: any[] = [];
  try {
    rows = (await getAllRecords(TABLES.RANCHER_PRODUCTS)) as any[];
  } catch {
    return [];
  }
  return rows
    .filter((r) => r['Active'] && Number(r['Display Price'] || 0) > 0)
    .map((r) => ({
      id: r.id,
      name: String(r['Product Name'] || ''),
      rancher: String(r['Rancher Name'] || ''),
      tier: String(sel(r['Resistance Tier'])),
      price: Number(r['Display Price'] || 0),
      base: Number(r['Rancher Base'] || 0),
      weight: String(r['Weight / Size'] || ''),
      shelfStable: !!r['Shelf Stable'],
    }))
    .sort((a, b) => a.price - b.price);
}

const RUNGS: { key: string; title: string; sub: string; tiers: string[] }[] = [
  { key: 'taste', title: 'taste the ranch', sub: 'the easiest first bite — ships anywhere, no freezer needed', tiers: ['Impulse'] },
  { key: 'stock', title: 'stock the freezer', sub: 'try the actual beef before a whole share', tiers: ['Starter', 'Mid'] },
  { key: 'share', title: 'a lite share', sub: 'a real cut of a whole animal', tiers: ['Share'] },
];

function Card({ p }: { p: Prod }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #A7A29A', padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={{ fontFamily: 'Georgia,serif', fontSize: 18, lineHeight: 1.2 }}>{p.name}</div>
        <div style={{ fontSize: 12.5, color: '#6B4F3F', marginTop: 2 }}>
          {p.rancher}{p.weight ? ` · ${p.weight}` : ''}
        </div>
      </div>
      <div style={{ fontSize: 12, color: '#55603F' }}>
        {p.shelfStable ? 'shelf-stable · ships anywhere' : 'ships frozen, nationwide'}
      </div>
      <div style={{ marginTop: 'auto' }}>
        <BuyButton productId={p.id} price={p.price} />
      </div>
    </div>
  );
}

export default async function ShopPage() {
  const products = await loadProducts();

  return (
    <main style={{ background: '#F4F1EC', minHeight: '100vh', padding: '48px 20px', fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif', color: '#17130E' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 'clamp(30px,6vw,44px)', margin: '0 0 8px' }}>real beef, shipped to your door</h1>
        <p style={{ color: '#3D362D', fontSize: 17, maxWidth: '52ch', margin: '0 0 8px', lineHeight: 1.5 }}>
          from real family ranches. try a ranch before you commit your freezer to it — then step up to a share.
        </p>

        {/* Anchor on the share — the destination the rungs point to. */}
        <div style={{ background: '#E6E9DC', borderLeft: '3px solid #55603F', padding: '14px 18px', margin: '20px 0 32px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontFamily: 'Georgia,serif', fontSize: 18 }}>going all in? a half or whole share</div>
            <div style={{ fontSize: 13, color: '#3D362D' }}>the best price per pound — a freezer stocked from one animal, one ranch, all year.</div>
          </div>
          <Link href="/map" style={{ padding: '10px 20px', background: '#17130E', color: '#F4F1EC', textDecoration: 'none', fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>
            find a ranch &rarr;
          </Link>
        </div>

        {products.length === 0 ? (
          <p style={{ color: '#6B4F3F' }}>the shop is stocking up — check back shortly.</p>
        ) : (
          RUNGS.map((rung) => {
            const items = products.filter((p) => rung.tiers.includes(p.tier));
            if (items.length === 0) return null;
            return (
              <section key={rung.key} style={{ marginBottom: 40 }}>
                <div style={{ fontFamily: 'Georgia,serif', fontSize: 24, marginBottom: 2 }}>{rung.title}</div>
                <div style={{ fontSize: 13.5, color: '#6B4F3F', marginBottom: 16 }}>{rung.sub}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14 }}>
                  {items.map((p) => <Card key={p.id} p={p} />)}
                </div>
              </section>
            );
          })
        )}

        <p style={{ fontSize: 12, color: '#A7A29A', marginTop: 40, borderTop: '1px solid #D8D0C2', paddingTop: 16 }}>
          checkout is secured by Stripe · your beef ships direct from the ranch · questions? reply to your receipt — a real person answers.
        </p>
      </div>
    </main>
  );
}
