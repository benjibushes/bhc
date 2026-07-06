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

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

export default function CheckoutMount({ productId }: { productId: string }) {
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
          body: JSON.stringify({ productId, mode: embedded ? 'embedded' : 'hosted' }),
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
  }, [productId]);

  const fetchClientSecret = useCallback(() => Promise.resolve(clientSecret), [clientSecret]);

  if (err) {
    return (
      <div style={{ background: '#fff', border: '1px solid #A7A29A', padding: 20 }}>
        <p style={{ color: '#8C3A2B', fontSize: 14, margin: '0 0 12px' }}>{err}</p>
        <Link href="/shop" style={{ fontSize: 14, fontWeight: 600, color: '#17130E' }}>&larr; back to the shop</Link>
      </div>
    );
  }

  if (stripePromise && clientSecret) {
    return (
      <>
        <div style={{ background: '#fff', border: '1px solid #A7A29A', padding: 4 }}>
          <EmbeddedCheckoutProvider stripe={stripePromise} options={{ fetchClientSecret }}>
            <EmbeddedCheckout />
          </EmbeddedCheckoutProvider>
        </div>
        <p style={{ fontSize: 12.5, color: '#6B4F3F', marginTop: 12, textAlign: 'center' }}>
          changed your mind? <Link href="/shop" style={{ color: '#6B4F3F' }}>&larr; back to shop</Link> — no charge until you finish.
        </p>
      </>
    );
  }

  // Live skeleton — reads as "working", not "broken", from the first paint.
  return (
    <div style={{ background: '#fff', border: '1px solid #A7A29A', padding: 20 }}>
      <div style={{ color: '#6B4F3F', fontSize: 14, marginBottom: 16 }}>securing your checkout&hellip;</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {[92, 100, 70, 100, 55].map((w, i) => (
          <div key={i} style={{ height: 12, width: `${w}%`, background: '#EAE6DE', borderRadius: 3 }} />
        ))}
      </div>
    </div>
  );
}
