'use client';

// Stage-3 Task 5 — post-Stripe-Checkout success page.
// Stripe redirects here after successful subscription Checkout.
// Pushes the rancher into the Connect onboarding flow next.

import { Suspense, useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';

export default function TierCheckoutSuccessPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bg text-text-primary flex items-center justify-center"><p>Loading…</p></div>}>
      <TierCheckoutSuccessContent />
    </Suspense>
  );
}

function TierCheckoutSuccessContent() {
  const params = useParams<{ tier: string }>();
  const search = useSearchParams();
  const sessionId = search.get('session_id') || '';
  const tier = String(params.tier || '').toLowerCase();
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  const startConnect = async () => {
    setStarting(true);
    setError('');
    try {
      const res = await fetch('/api/rancher/connect/start', {
        method: 'POST',
        credentials: 'include',
      });
      const j = await res.json();
      if (!res.ok) {
        setError(j?.error || 'Connect start failed');
        setStarting(false);
        return;
      }
      if (j?.url) {
        window.location.href = j.url;
      } else {
        setError('No onboarding URL returned');
        setStarting(false);
      }
    } catch (e: any) {
      setError(e?.message || 'Network error');
      setStarting(false);
    }
  };

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-4xl mb-2" style={{ fontFamily: 'Georgia, serif' }}>
          🎉 You're in.
        </h1>
        <p className="text-saddle mb-8 text-lg">
          Welcome to <strong>BuyHalfCow {tierLabel}</strong>. Subscription active.
        </p>

        <div className="bg-white border border-dust p-6 mb-8">
          <h2 className="text-xl mb-3" style={{ fontFamily: 'Georgia, serif' }}>
            One more step — connect your bank
          </h2>
          <p className="text-sm text-saddle mb-2"><strong>Why this step?</strong></p>
          <p className="mb-4">
            By federal law (KYC), any platform handling payments must verify your identity before sending money. Stripe (not BHC) holds your data.
          </p>
          <p className="text-sm text-saddle mb-2"><strong>What you'll need (~5 min):</strong></p>
          <ul className="text-sm text-saddle space-y-1 mb-4 ml-4">
            <li>• Your legal name + SSN or EIN</li>
            <li>• Bank account routing + account number</li>
            <li>• Photo ID (driver's license)</li>
            <li>• Date of birth + address</li>
          </ul>
          <p className="text-sm text-saddle mb-6">
            Same flow PayPal, Square, and DoorDash use. You can pause and resume anytime.
          </p>
          <button
            onClick={startConnect}
            disabled={starting}
            className="bg-charcoal text-bone px-8 py-4 uppercase tracking-wider text-sm hover:bg-saddle transition disabled:opacity-50"
          >
            {starting ? 'Loading Stripe…' : 'Continue with Stripe →'}
          </button>
        </div>

        {error && <p className="text-red-700 mt-4 text-sm">{error}</p>}

        <p className="text-saddle text-xs mt-8">
          Or skip for now — your subscription is active. You can connect your bank anytime from{' '}
          <Link href="/rancher/billing" className="underline">/rancher/billing</Link>. But matching won't fire until your bank is connected.
        </p>

        {sessionId && (
          <p className="text-xs text-dust mt-2">
            Receipt: <code className="text-saddle">{sessionId.slice(0, 28)}…</code>
          </p>
        )}
      </div>
    </main>
  );
}
