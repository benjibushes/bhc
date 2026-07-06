'use client';

// app/shop/checkout/[id]/page.tsx
//
// The whitelabeled, on-domain checkout. Buyer taps "buy" → lands here (still on
// buyhalfcow.com) → Stripe's payment form renders in an iframe RIGHT HERE, no
// redirect to checkout.stripe.com.
//
// It's a DIRECT charge on the rancher's connected account, so Stripe.js must be
// scoped to that account: loadStripe(platformPublishableKey, { stripeAccount }).
// We load from '@stripe/stripe-js/pure' so a fresh account is used per product
// (the default singleton caches the first account and ignores later ones).
//
// GRACEFUL FALLBACK: if NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY isn't set, we can't
// mount Elements — so we ask the buy endpoint for a hosted session and redirect,
// exactly like before. Checkout never breaks; it just isn't on-domain until the
// key is set in Vercel. Settlement is webhook-driven and identical either way.

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe } from '@stripe/stripe-js';
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js';

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

export default function ProductCheckoutPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);
  const [clientSecret, setClientSecret] = useState('');
  const [err, setErr] = useState('');
  const startedRef = useRef(false);

  useEffect(() => {
    if (!id || startedRef.current) return;
    startedRef.current = true; // StrictMode double-invoke / re-render guard — one session only
    let cancelled = false;

    (async () => {
      try {
        const embedded = !!PUBLISHABLE_KEY;
        const res = await fetch('/api/checkout/product/buy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId: id, mode: embedded ? 'embedded' : 'hosted' }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'could not start checkout');

        if (!embedded) {
          // No publishable key → hosted redirect (old behavior).
          if (!data?.url) throw new Error('could not start checkout');
          window.location.href = data.url;
          return;
        }

        if (!data?.clientSecret || !data?.connectAccountId) {
          throw new Error('could not start checkout');
        }
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
  }, [id]);

  const fetchClientSecret = useCallback(() => Promise.resolve(clientSecret), [clientSecret]);

  return (
    <main
      style={{
        background: '#F4F1EC',
        minHeight: '100vh',
        padding: '28px 16px 56px',
        fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
        color: '#17130E',
      }}
    >
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <Link href="/shop" style={{ fontSize: 13.5, color: '#6B4F3F', textDecoration: 'none' }}>
          &larr; back to shop
        </Link>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 26, margin: '12px 0 16px' }}>checkout</h1>

        {err ? (
          <div style={{ background: '#fff', border: '1px solid #A7A29A', padding: 20 }}>
            <p style={{ color: '#8C3A2B', fontSize: 14, margin: '0 0 12px' }}>{err}</p>
            <Link
              href="/shop"
              style={{ fontSize: 14, fontWeight: 600, color: '#17130E' }}
            >
              &larr; back to the shop
            </Link>
          </div>
        ) : stripePromise && clientSecret ? (
          <div style={{ background: '#fff', border: '1px solid #A7A29A', padding: 4 }}>
            <EmbeddedCheckoutProvider stripe={stripePromise} options={{ fetchClientSecret }}>
              <EmbeddedCheckout />
            </EmbeddedCheckoutProvider>
          </div>
        ) : (
          <p style={{ color: '#6B4F3F', fontSize: 15 }}>loading secure checkout…</p>
        )}

        <p style={{ fontSize: 12, color: '#A7A29A', marginTop: 20, lineHeight: 1.5 }}>
          payments secured by Stripe · your beef ships direct from the ranch · questions? reply to your receipt — a real person answers.
        </p>
      </div>
    </main>
  );
}
