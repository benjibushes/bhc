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
import Card from '../../../components/Card';
import PriceTag from '../../../components/PriceTag';
import TrustStrip from '../../../components/TrustStrip';

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
    <main className="min-h-screen bg-bone text-charcoal pt-7 pb-14 px-4">
      <div className="max-w-[640px] mx-auto">
        <Link href={`/shop/${p.id}`} className="text-[13.5px] text-saddle hover:text-charcoal transition-colors">
          &larr; back
        </Link>
        <h1 className="font-serif text-2xl mt-3 mb-4 lowercase">checkout</h1>

        {/* Branded order summary — the buyer re-sees exactly what they're buying,
            in BuyHalfCow chrome, even though Stripe's inner form is ranch-named.
            Visually matches the high-ticket deposit checkout (one company). */}
        <Card padding="sm" className="flex gap-3.5 items-center mb-4">
          <div className="w-[72px] h-[72px] shrink-0 overflow-hidden bg-bone-deep">
            <ProductImage src={p.image} alt={p.name} className="w-full h-full object-cover block" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-serif text-[17px] leading-tight">{p.name}</div>
            <div className="text-xs text-saddle mt-0.5">{p.rancher} · ships direct from the ranch</div>
          </div>
          <PriceTag amount={p.price} size="sm" className="whitespace-nowrap" />
        </Card>

        <CheckoutMount productId={p.id} />

        <TrustStrip className="text-xs mt-5" />
      </div>
    </main>
  );
}
