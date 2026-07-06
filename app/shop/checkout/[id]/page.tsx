// app/shop/checkout/[id]/page.tsx
//
// The whitelabeled, on-domain checkout — server wrapper. Loads the product so it
// can (1) render a BuyHalfCow-branded ORDER SUMMARY above the Stripe iframe
// (reclaims the brand from the ranch-named Stripe form), (2) 404 immediately on a
// bad/unsellable id (no client loading flash for a typo'd URL), and (3) set
// noindex (checkout pages must never enter search). The chrome is sealed by
// ChromeGate (/shop/checkout is in FOCUSED_PREFIXES) — no nav, no promo bar.
// The client half (CheckoutMount) mounts the actual Stripe Embedded Checkout.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { loadMarketplaceProduct } from '@/lib/marketplaceProducts';
import ProductImage from '../../ProductImage';
import CheckoutMount from './CheckoutMount';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'checkout',
  robots: { index: false, follow: false },
};

export default async function ProductCheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await loadMarketplaceProduct(id);
  if (!p) notFound(); // bad / inactive / unsellable id → immediate 404, no loading flash

  return (
    <main style={{ background: '#F4F1EC', minHeight: '100vh', padding: '28px 16px 56px', fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif', color: '#17130E' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <Link href={`/shop/${p.id}`} style={{ fontSize: 13.5, color: '#6B4F3F', textDecoration: 'none' }}>&larr; back</Link>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 26, margin: '12px 0 16px' }}>checkout</h1>

        {/* Branded order summary — the buyer re-sees exactly what they're buying,
            in BuyHalfCow chrome, even though Stripe's inner form is ranch-named. */}
        <div style={{ background: '#fff', border: '1px solid #A7A29A', padding: 14, display: 'flex', gap: 14, alignItems: 'center', marginBottom: 16 }}>
          <div style={{ width: 72, height: 72, flexShrink: 0, overflow: 'hidden', background: '#EAE6DE' }}>
            <ProductImage src={p.image} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'Georgia,serif', fontSize: 17, lineHeight: 1.2 }}>{p.name}</div>
            <div style={{ fontSize: 12.5, color: '#6B4F3F', marginTop: 2 }}>{p.rancher} · ships direct from the ranch</div>
          </div>
          <div style={{ fontFamily: 'Georgia,serif', fontSize: 20, whiteSpace: 'nowrap' }}>${p.price.toFixed(2)}</div>
        </div>

        <CheckoutMount productId={p.id} />

        <p style={{ fontSize: 12, color: '#A7A29A', marginTop: 20, lineHeight: 1.5 }}>
          payments secured by Stripe · shipping included · a real person answers your receipt. &mdash; Ben
        </p>
      </div>
    </main>
  );
}
