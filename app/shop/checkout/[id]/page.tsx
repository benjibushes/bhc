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
import { loadMarketplaceProductAnyStock } from '@/lib/marketplaceProducts';
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
  const loaded = await loadMarketplaceProductAnyStock(id);
  if (!loaded) notFound(); // bad / inactive / unsellable id → immediate 404, no loading flash
  const { product: p, soldOut } = loaded;

  // GTM-hardening F4: a buyer arriving from a stale (ISR) PDP after a
  // sell-out gets an honest sold-out state — never a 404 one tap from paying.
  // This page is force-dynamic, so the state here is always fresh truth.
  if (soldOut) {
    return (
      <main className="min-h-screen bg-bone text-charcoal pt-7 pb-14 px-4">
        <div className="max-w-[640px] mx-auto text-center">
          <Card padding="lg">
            <h1 className="font-serif text-2xl mb-2 lowercase">sold out</h1>
            <p className="text-sm text-saddle leading-relaxed mb-4">
              <strong>{p.name}</strong> from {p.rancher} is sold out — this batch is spoken for,
              and the ranch restocks as the next animals come through. nothing was charged.
            </p>
            <Link
              href="/shop"
              className="inline-block px-5 py-3 bg-charcoal text-bone text-sm font-medium uppercase tracking-wider hover:bg-saddle transition-colors"
            >
              see what&rsquo;s available now &rarr;
            </Link>
          </Card>
        </div>
      </main>
    );
  }

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
            <div className="text-xs text-saddle mt-0.5">
              {p.rancher} · {p.depositStyle ? 'deposit — details confirmed with you' : 'ships direct from the ranch'}
            </div>
          </div>
          <div className="text-right">
            <PriceTag amount={p.price} size="sm" className="whitespace-nowrap" />
            {p.depositStyle ? (
              <div className="text-[10px] uppercase tracking-wider text-saddle">deposit</div>
            ) : null}
          </div>
        </Card>

        {/* Deposit-style: say exactly what today's charge is BEFORE the card
            form — no surprise-balance pattern, ever. */}
        {p.depositStyle ? (
          <p className="text-[12.5px] text-saddle leading-relaxed mb-4 -mt-1">
            you&rsquo;re paying a <strong>${p.price.toFixed(0)} deposit</strong> today
            {p.priceRange ? <> toward a {p.priceRange} total</> : null}. {p.rancher} will reach out
            to confirm your size + the balance before anything ships — and your deposit counts
            toward it.
          </p>
        ) : null}

        <CheckoutMount productId={p.id} />

        <TrustStrip className="text-xs mt-5" />
      </div>
    </main>
  );
}
