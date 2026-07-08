'use client';

// The client half of the whitelabeled checkout. Mounts Stripe's Embedded
// Checkout in an iframe on buyhalfcow.com (direct charge on the rancher's
// connected account, so Stripe.js is scoped to that account). If
// NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY isn't set, it asks the buy endpoint for a
// hosted session and redirects — checkout never breaks. The server wrapper
// (page.tsx) renders the branded order summary above this; here we just show a
// live skeleton until the form mounts, then a quiet "changed your mind?" line.

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe } from '@stripe/stripe-js';
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js';
import PaymentForm from './PaymentForm';

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

export interface PaymentElementConfig {
  connectAccountId: string;
  totalCents: number;
  depositStyle: boolean;
  localOnly: boolean;
}

export default function CheckoutMount({
  productId,
  quantity = 1,
  paymentElement = null,
}: {
  productId: string;
  quantity?: number;
  /**
   * BRAND-OWNED CHECKOUT (Payment Element migration, spec R10 rollback flag).
   * When the server page passes this (flag on + publishable key + Connect
   * account resolved), the on-domain PaymentForm renders instead of the
   * embedded Stripe iframe. null → legacy embedded/hosted flow, byte-identical
   * to before — flip NEXT_PUBLIC_PRODUCT_PAYMENT_ELEMENT off to roll back.
   */
  paymentElement?: PaymentElementConfig | null;
}) {
  if (paymentElement && PUBLISHABLE_KEY) {
    return (
      <PaymentForm
        publishableKey={PUBLISHABLE_KEY}
        connectAccountId={paymentElement.connectAccountId}
        productId={productId}
        quantity={quantity}
        totalCents={paymentElement.totalCents}
        depositStyle={paymentElement.depositStyle}
        localOnly={paymentElement.localOnly}
      />
    );
  }
  return <LegacyEmbeddedMount productId={productId} quantity={quantity} />;
}

function LegacyEmbeddedMount({ productId, quantity }: { productId: string; quantity: number }) {
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);
  const [clientSecret, setClientSecret] = useState('');
  const [err, setErr] = useState('');
  const startedRef = useRef(false);

  useEffect(() => {
    if (!productId || startedRef.current) return;
    startedRef.current = true; // StrictMode / re-render guard — one session only
    let cancelled = false;

    (async () => {
      try {
        const embedded = !!PUBLISHABLE_KEY;
        const res = await fetch('/api/checkout/product/buy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId, quantity, mode: embedded ? 'embedded' : 'hosted' }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'could not start checkout');

        if (!embedded) {
          if (!data?.url) throw new Error('could not start checkout');
          window.location.href = data.url; // hosted fallback
          return;
        }
        if (!data?.clientSecret || !data?.connectAccountId) throw new Error('could not start checkout');
        if (cancelled) return;
        setClientSecret(data.clientSecret);
        setStripePromise(loadStripe(PUBLISHABLE_KEY!, { stripeAccount: data.connectAccountId }));
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || 'something went wrong');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [productId, quantity]);

  const fetchClientSecret = useCallback(() => Promise.resolve(clientSecret), [clientSecret]);

  if (err) {
    return (
      <div className="bg-bone border border-dust p-5">
        <p className="text-weathered text-sm mb-3">{err}</p>
        <Link href="/shop" className="text-sm font-semibold text-charcoal underline underline-offset-4">
          &larr; back to the shop
        </Link>
      </div>
    );
  }

  if (stripePromise && clientSecret) {
    return (
      <>
        <div className="bg-white border border-dust p-1">
          <EmbeddedCheckoutProvider stripe={stripePromise} options={{ fetchClientSecret }}>
            <EmbeddedCheckout />
          </EmbeddedCheckoutProvider>
        </div>
        <p className="text-xs text-saddle mt-3 text-center">
          changed your mind?{' '}
          <Link href="/shop" className="underline hover:text-charcoal transition-colors">
            &larr; back to shop
          </Link>{' '}
          — no charge until you finish.
        </p>
      </>
    );
  }

  // Live skeleton — reads as "working", not "broken", from the first paint.
  return (
    <div className="bg-bone border border-dust p-5">
      <div className="text-saddle text-sm mb-4">securing your checkout&hellip;</div>
      <div className="flex flex-col gap-3">
        {[92, 100, 70, 100, 55].map((w, i) => (
          <div key={i} className="h-3 bg-bone-deep rounded-[3px]" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}
