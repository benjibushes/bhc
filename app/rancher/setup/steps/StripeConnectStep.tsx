'use client';

// Stage-3 Task D2 — inline Stripe Connect onboarding inside the setup wizard.
//
// Why this lives here (not /rancher/billing): tier_v2 ranchers used to be
// asked to finish bank setup AFTER the wizard, on the billing dashboard.
// Many forgot, blocking buyer deposits from settling direct. Inlining the CTA
// right after Pick-Your-Plan + before sign gets ~90% of tier_v2 ranchers
// through Connect onboarding the same session they signed up.
//
// Behavior:
//   - Legacy ranchers (pricingModel !== 'tier_v2') auto-advance — they get
//     monthly commission invoices, no Connect account needed.
//   - tier_v2 ranchers see a "Connect bank account" CTA → POST
//     /api/rancher/connect/start → redirect to Stripe-hosted onboarding URL.
//   - "Skip for now" available — they can finish on /rancher/billing later.
//
// The /api/rancher/connect/start endpoint authenticates via rancher-session
// cookie (set by the setup token flow), so no rancherId payload required.

import { useEffect, useState } from 'react';

interface Props {
  rancherId: string;
  pricingModel: 'legacy' | 'tier_v2' | string;
  wizardToken?: string;
  onComplete: () => void;
  onBack?: () => void;
}

export default function StripeConnectStep({ rancherId, pricingModel, wizardToken, onComplete, onBack }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Legacy ranchers skip this step entirely — auto-advance on mount.
  // Use effect so the parent wizard's setState doesn't fire during render.
  useEffect(() => {
    if (pricingModel !== 'tier_v2') {
      onComplete();
    }
  }, [pricingModel, onComplete]);

  // While the auto-advance effect is queued, render nothing for legacy.
  // Prevents a flash of the tier_v2 UI for a legacy rancher.
  if (pricingModel !== 'tier_v2') {
    return null;
  }

  const handleConnect = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/rancher/connect/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // from='wizard' + wizardToken tell the route to set return_url back
        // to the setup wizard (Step 8) instead of /rancher/billing — so the
        // rancher resumes Fulfillment + Sign rather than getting stranded.
        body: JSON.stringify({ rancherId, from: 'wizard', wizardToken }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Connect failed (${res.status})`);
      }
      const data = await res.json();
      // Endpoint returns { url, accountId } — accept either url or
      // onboardingUrl to stay forward-compatible.
      const target = data.url || data.onboardingUrl;
      if (!target) throw new Error('No onboarding URL returned');
      window.location.href = target;
    } catch (e: any) {
      setError(e?.message || 'Failed to start Stripe Connect.');
      setLoading(false);
    }
  };

  return (
    <section className="space-y-6 bg-bone border border-dust p-7 md:p-8">
      <header>
        <p className="text-xs uppercase tracking-widest text-saddle mb-2">
          Step 7 · Connect Your Bank
        </p>
        <h2 className="font-serif text-2xl md:text-3xl text-charcoal">
          Connect your bank account.
        </h2>
        <p className="text-sm text-saddle mt-1">
          Stripe handles bank deposits directly. BHC never touches your money.
          You get paid the day after a buyer confirms beef delivery.
        </p>
      </header>

      <ul className="space-y-2 text-sm text-charcoal/85">
        <li>· Stripe is the same payments rails used by Shopify, Lyft, and Amazon</li>
        <li>· 2-3 minutes to finish — needs your bank routing + SSN</li>
        <li>· Encrypted end-to-end. BHC never sees your bank details.</li>
        <li>· 90% of the buyer deposit lands in your account within 48 hours</li>
      </ul>

      {error && (
        <div className="p-3 border border-rust text-rust text-sm">{error}</div>
      )}

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          onClick={handleConnect}
          disabled={loading}
          className="px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider disabled:opacity-50"
        >
          {loading ? 'Redirecting to Stripe…' : 'Connect bank account →'}
        </button>
        <button
          onClick={onComplete}
          className="text-sm text-saddle underline hover:text-charcoal transition-colors"
        >
          Skip for now
        </button>
      </div>

      <p className="text-xs text-saddle/80">
        You can also finish this later from your /rancher/billing dashboard.
        We can&apos;t route buyer deposits to you until Connect is verified.
      </p>

      {onBack && (
        <div className="pt-2">
          <button
            onClick={onBack}
            className="text-xs uppercase tracking-widest text-saddle hover:text-charcoal transition-colors"
          >
            ← Back
          </button>
        </div>
      )}
    </section>
  );
}
