'use client';

// WHITELABEL deposit checkout (2026-07-07). Mounts Stripe's Embedded Checkout
// in an iframe ON buyhalfcow.com for the share deposit — the $1k+ moment used
// to redirect to checkout.stripe.com, the single most "tech platform" step in
// the whole buyer journey. Direct charge on the rancher's connected account,
// so Stripe.js is scoped to that account. Money model, metadata, and webhooks
// are byte-identical to the hosted flow — presentation only. The page keeps
// the hosted redirect as fallback when the publishable key is absent.

import { useCallback } from 'react';
import { loadStripe } from '@stripe/stripe-js/pure';
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js';

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

export function depositEmbeddedAvailable(): boolean {
  return !!PUBLISHABLE_KEY;
}

export default function DepositCheckoutMount({
  clientSecret,
  connectAccountId,
}: {
  clientSecret: string;
  connectAccountId: string;
}) {
  const fetchClientSecret = useCallback(() => Promise.resolve(clientSecret), [clientSecret]);
  if (!PUBLISHABLE_KEY) return null;
  const stripePromise = loadStripe(PUBLISHABLE_KEY, { stripeAccount: connectAccountId });

  return (
    <div className="bg-white border border-dust p-1">
      <EmbeddedCheckoutProvider stripe={stripePromise} options={{ fetchClientSecret }}>
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}
