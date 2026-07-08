'use client';

// BRAND-OWNED CHECKOUT form (Payment Element migration — spec §3/§4).
// The payment fields live INSIDE our page, skinned to brand tokens — no
// iframe chrome, no Stripe-looking checkout. Flow (deferred intent):
//   1. buyer fills email (ours) + shipping (AddressElement) + card/wallet
//      (PaymentElement) — no PaymentIntent exists yet
//   2. pay-click: elements.submit() → POST /api/checkout/product/intent
//      (every stock/rancher gate re-runs seconds before the charge) →
//      stripe.confirmPayment with the fresh clientSecret
//   3. success → /order/success; decline → inline error, SAME intent reused
//      (cached clientSecret — no duplicate mint, idempotent by attemptId)
//
// Shipping lands on pi.shipping at confirm (settlement's formatShipping
// reads it); email rides metadata.buyerEmail (settlement receipt chain #1).

import { useMemo, useRef, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, AddressElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { bhcAppearance, bhcFonts } from '@/lib/stripeAppearance';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

function InnerForm({
  productId,
  quantity,
  totalCents,
  depositStyle,
}: {
  productId: string;
  quantity: number;
  totalCents: number;
  depositStyle: boolean;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [paying, setPaying] = useState(false);
  // One attempt id per mount → Stripe idempotency; cached secret on decline
  // so retries re-confirm the SAME intent instead of minting another.
  const attemptIdRef = useRef<string>('');
  if (!attemptIdRef.current && typeof crypto !== 'undefined') {
    attemptIdRef.current = crypto.randomUUID();
  }
  const cachedSecretRef = useRef<string>('');
  const inFlightRef = useRef(false);

  const pay = async () => {
    if (!stripe || !elements || inFlightRef.current) return;
    setErr('');
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setErr('add your email — it’s where your receipt and tracking go.');
      return;
    }
    inFlightRef.current = true;
    setPaying(true);
    try {
      // Validate the collected fields BEFORE minting anything.
      const submitted = await elements.submit();
      if (submitted.error) {
        setErr(submitted.error.message || 'check the highlighted fields.');
        return;
      }

      let clientSecret = cachedSecretRef.current;
      if (!clientSecret) {
        const res = await fetch('/api/checkout/product/intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productId,
            quantity,
            email: cleanEmail,
            attemptId: attemptIdRef.current,
            expectedTotalCents: totalCents,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (data?.demoUrl) {
          window.location.href = data.demoUrl;
          return;
        }
        if (!res.ok) {
          setErr(data?.message || data?.error || 'could not start checkout — try again.');
          return;
        }
        if (!data?.clientSecret) {
          setErr('could not start checkout — try again.');
          return;
        }
        clientSecret = data.clientSecret;
        cachedSecretRef.current = clientSecret;
      }

      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        clientSecret,
        confirmParams: {
          return_url: `${SITE_URL}/order/success?pid=${productId}`,
        },
        redirect: 'if_required',
      });
      if (error) {
        // Card declined / auth failed — intent stays reusable; honest message.
        setErr(error.message || 'that payment didn’t go through — nothing was charged. try another card.');
        return;
      }
      if (paymentIntent && (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing')) {
        window.location.href = `/order/success?pid=${productId}`;
      }
    } catch {
      setErr('network hiccup — nothing was charged. try again.');
    } finally {
      inFlightRef.current = false;
      setPaying(false);
    }
  };

  return (
    <div className="bg-white border border-dust p-5 space-y-4">
      <label className="block">
        <span className="block text-[13px] text-saddle mb-1.5">
          email — for your receipt + tracking
        </span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          className="w-full p-3 border border-dust bg-white text-[15px]"
        />
      </label>

      <div>
        <span className="block text-[13px] text-saddle mb-1.5">shipping address</span>
        <AddressElement options={{ mode: 'shipping', allowedCountries: ['US'] }} />
      </div>

      <div>
        <span className="block text-[13px] text-saddle mb-1.5">payment</span>
        <PaymentElement options={{ layout: 'accordion' }} />
      </div>

      {err && <p className="text-sm text-weathered">{err}</p>}

      <button
        onClick={pay}
        disabled={paying || !stripe || !elements}
        className="w-full bg-charcoal text-bone px-6 py-4 min-h-[48px] text-base font-medium hover:bg-saddle transition-colors disabled:opacity-50"
      >
        {paying
          ? 'securing your order…'
          : depositStyle
            ? `reserve — $${(totalCents / 100).toFixed(2)} deposit`
            : `pay $${(totalCents / 100).toFixed(2)}`}
      </button>
      <p className="text-xs text-saddle text-center leading-relaxed">
        secured by stripe · we never see or store your card · nothing is charged until you tap pay
      </p>
    </div>
  );
}

export default function PaymentForm({
  publishableKey,
  connectAccountId,
  productId,
  quantity,
  totalCents,
  depositStyle,
}: {
  publishableKey: string;
  connectAccountId: string;
  productId: string;
  quantity: number;
  totalCents: number;
  depositStyle: boolean;
}) {
  // Scope Stripe.js to the connected account — direct charge confirm requires it.
  const stripePromise = useMemo<Promise<Stripe | null>>(
    () => loadStripe(publishableKey, { stripeAccount: connectAccountId }),
    [publishableKey, connectAccountId],
  );

  return (
    <Elements
      stripe={stripePromise}
      options={{
        mode: 'payment',
        amount: totalCents,
        currency: 'usd',
        appearance: bhcAppearance,
        fonts: bhcFonts,
      }}
    >
      <InnerForm
        productId={productId}
        quantity={quantity}
        totalCents={totalCents}
        depositStyle={depositStyle}
      />
    </Elements>
  );
}
