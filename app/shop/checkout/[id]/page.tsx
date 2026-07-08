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
import { getRecordById, TABLES } from '@/lib/airtable';
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

export default async function ProductCheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ qty?: string }>;
}) {
  const { id } = await params;
  const loaded = await loadMarketplaceProductAnyStock(id);
  if (!loaded) notFound(); // bad / inactive / unsellable id → immediate 404, no loading flash
  const { product: p, soldOut } = loaded;

  // Quantity from the PDP picker (?qty=N). Clamped here for the summary; the
  // buy endpoint re-clamps + stock-checks server-side (URL is not trusted).
  const sp = await searchParams;
  const qtyRaw = Number(sp?.qty || 1);
  const quantity = p.depositStyle
    ? 1
    : Math.min(5, Math.max(1, Number.isInteger(qtyRaw) ? qtyRaw : 1));

  // BRAND-OWNED CHECKOUT (Payment Element migration, spec R10 rollback flag):
  // when the flag is on, resolve the Connect account SERVER-SIDE so the
  // on-domain PaymentForm can scope Stripe.js with zero extra client round
  // trips. Any miss (flag off, no key, rancher not active) → null → legacy
  // embedded/hosted flow, byte-identical to before.
  let paymentElement: { connectAccountId: string; totalCents: number; depositStyle: boolean } | null = null;
  if (
    process.env.NEXT_PUBLIC_PRODUCT_PAYMENT_ELEMENT === 'true' &&
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY &&
    !soldOut
  ) {
    try {
      const rr: any = p.rancherId ? await getRecordById(TABLES.RANCHERS, p.rancherId) : null;
      const acct = String(rr?.['Stripe Connect Account Id'] || '').trim();
      if (rr && String(rr['Stripe Connect Status'] || '') === 'active' && acct) {
        paymentElement = {
          connectAccountId: acct,
          totalCents:
            Math.round(p.price * 100) * quantity +
            (p.depositStyle ? 0 : Math.round(p.shippingCost * 100)),
          depositStyle: p.depositStyle,
        };
      }
    } catch { /* legacy flow — never block checkout on this lookup */ }
  }

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
            <div className="font-serif text-[17px] leading-tight">
              {quantity > 1 ? `${quantity}× ` : ''}{p.name}
            </div>
            <div className="text-xs text-saddle mt-0.5">
              {p.rancher} · {p.depositStyle ? 'deposit — details confirmed with you' : 'ships direct from the ranch'}
            </div>
          </div>
          <div className="text-right">
            <PriceTag amount={p.price * quantity + (p.depositStyle ? 0 : p.shippingCost)} size="sm" className="whitespace-nowrap" />
            {p.depositStyle ? (
              <div className="text-[10px] uppercase tracking-wider text-saddle">deposit</div>
            ) : quantity > 1 || p.shippingCost > 0 ? (
              <div className="text-[10px] uppercase tracking-wider text-saddle whitespace-nowrap">
                {quantity > 1 ? `${quantity} × $${p.price.toFixed(2)}` : ''}
                {quantity > 1 && p.shippingCost > 0 ? ' + ' : ''}
                {p.shippingCost > 0 ? `$${p.shippingCost.toFixed(2)} shipping` : ''}
              </div>
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

        {/* Buy-moment reassurance (checkout teardown 2026-07-07): delivery
            expectation + honest scarcity + the guarantee, ABOVE the payment
            form — the exact spot purchase anxiety peaks. Every line is
            data-true or a standing operational promise; nothing fabricated. */}
        <div className="text-[12.5px] text-saddle leading-relaxed mb-4 space-y-1">
          {!p.depositStyle && (
            <p>
              {p.shipsInDays
                ? <>ships from the ranch within ~{p.shipsInDays} {p.shipsInDays === 1 ? 'day' : 'days'} — tracking hits your inbox the moment it&rsquo;s on the way.</>
                : <>ships direct from the ranch — tracking hits your inbox the moment it&rsquo;s on the way.</>}
            </p>
          )}
          {!soldOut && p.ordersLeft !== null && p.ordersLeft <= 10 && (
            <p>{p.ordersLeft} {p.ordersLeft === 1 ? 'order' : 'orders'} left from this batch.</p>
          )}
          <p>
            if anything shows up wrong or freezer-burned, we make it right — no forms, no runaround.
          </p>
        </div>

        {/* Warm up Stripe's origin while the buyer reads the summary —
            shaves the iframe's connection setup off perceived load time. */}
        <link rel="preconnect" href="https://js.stripe.com" />

        <CheckoutMount productId={p.id} quantity={quantity} paymentElement={paymentElement} />

        <TrustStrip className="text-xs mt-5" />
      </div>
    </main>
  );
}
