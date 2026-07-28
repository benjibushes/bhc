'use client';

// WHITELABEL deposit checkout (2026-07-07). Mounts Stripe's Embedded Checkout
// in an iframe ON buyhalfcow.com for the share deposit — the $1k+ moment used
// to redirect to checkout.stripe.com, the single most "tech platform" step in
// the whole buyer journey. Direct charge on the rancher's connected account,
// so Stripe.js is scoped to that account. Money model, metadata, and webhooks
// are byte-identical to the hosted flow — presentation only. The page keeps
// the hosted redirect as fallback when the publishable key is absent.
//
// K2 (conversion audit 2026-07-28): Stripe.js can fail to load (ad blocker,
// flaky mobile network) — the buyer used to get an empty bordered box forever
// at the $1k+ moment. Now: loadStripe is memoized (was re-created every
// render), a load failure auto-falls-back to the HOSTED checkout via
// onHostedFallback (the page re-POSTs without mode:'embedded' and redirects —
// the same pattern the shop rail uses in app/shop/checkout/[id]/
// CheckoutMount.tsx), and if that also fails the buyer sees an explicit
// retry state instead of silence.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js/pure';
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js';

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

export function depositEmbeddedAvailable(): boolean {
  return !!PUBLISHABLE_KEY;
}

export default function DepositCheckoutMount({
  clientSecret,
  connectAccountId,
  onHostedFallback,
}: {
  clientSecret: string;
  connectAccountId: string;
  /**
   * Re-POST the checkout WITHOUT mode:'embedded' and redirect to the hosted
   * Stripe url. Resolves false when that also failed (so this component can
   * show the retry state); on success it navigates away and never resolves
   * false. Provided by the deposit page, which owns the POST.
   */
  onHostedFallback?: () => Promise<boolean>;
}) {
  const fetchClientSecret = useCallback(() => Promise.resolve(clientSecret), [clientSecret]);
  // Memoized — this used to run in the render body, kicking off a fresh
  // loadStripe on every re-render of the money page.
  const stripePromise = useMemo(
    () => (PUBLISHABLE_KEY ? loadStripe(PUBLISHABLE_KEY, { stripeAccount: connectAccountId }) : null),
    [connectAccountId],
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const [fallingBack, setFallingBack] = useState(false);
  const [fallbackFailed, setFallbackFailed] = useState(false);

  // Detect a Stripe.js load failure (script blocked / network drop): the
  // promise rejects, or resolves null. Either way the embedded frame would
  // never appear — flip to the fallback path instead of an empty box.
  useEffect(() => {
    if (!stripePromise) return;
    let cancelled = false;
    stripePromise.then(
      (stripe) => { if (!cancelled && !stripe) setLoadFailed(true); },
      () => { if (!cancelled) setLoadFailed(true); },
    );
    return () => { cancelled = true; };
  }, [stripePromise]);

  const fallBackToHosted = useCallback(async () => {
    if (!onHostedFallback) { setFallbackFailed(true); return; }
    setFallingBack(true);
    setFallbackFailed(false);
    const ok = await onHostedFallback().catch(() => false);
    // ok=true → the page is redirecting to checkout.stripe.com; leave the
    // "taking you there" copy up until navigation lands.
    if (!ok) { setFallingBack(false); setFallbackFailed(true); }
  }, [onHostedFallback]);

  // Auto-attempt the hosted fallback once, the moment the load failure is
  // known — the buyer shouldn't need to press anything for the happy rescue.
  useEffect(() => {
    if (loadFailed) void fallBackToHosted();
  }, [loadFailed, fallBackToHosted]);

  if (!PUBLISHABLE_KEY) return null;

  if (loadFailed) {
    return (
      <div className="bg-white border border-dust p-5 text-center space-y-3">
        {fallingBack ? (
          <p className="text-sm text-saddle">
            the payment form didn&apos;t load here — taking you to our secure Stripe checkout&hellip;
          </p>
        ) : (
          <>
            <p className="text-sm text-charcoal">
              the secure payment form didn&apos;t load. your card was <strong>not</strong> charged.
            </p>
            <button
              type="button"
              onClick={() => void fallBackToHosted()}
              className="px-6 py-3 bg-charcoal text-bone text-sm uppercase tracking-wide hover:bg-saddle transition-colors"
            >
              try again
            </button>
            {fallbackFailed && (
              <p className="text-xs text-saddle">
                still stuck? an ad blocker or a network blip can cause this — pause it or switch networks, then try again.
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white border border-dust p-1">
      <EmbeddedCheckoutProvider stripe={stripePromise} options={{ fetchClientSecret }}>
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}
