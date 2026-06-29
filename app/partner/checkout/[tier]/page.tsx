'use client';

// Stage-3 Task 5 — Tier checkout entry page.
// Confirms the tier the rancher picked at /partner, lists the 5-step
// post-Checkout timeline, fires POST /api/rancher/tier/select on click.
// On 401/missing session: redirects to /rancher/login?return=/partner/checkout/<tier>.

import { Suspense, useState, useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

const TIER_DATA: Record<string, { label: string; monthly: number; rate: number; promise: string }> = {
  pasture: { label: 'Pasture', monthly: 150, rate: 7, promise: 'We send you buyers' },
  ranch: { label: 'Ranch', monthly: 350, rate: 3, promise: 'We send you buyers AND make sure they see you first' },
  operator: { label: 'Operator', monthly: 500, rate: 0, promise: 'We send you buyers, position you, and run your marketing' },
};

export default function TierCheckoutPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bone text-charcoal flex items-center justify-center"><p>Loading…</p></div>}>
      <TierCheckoutContent />
    </Suspense>
  );
}

function TierCheckoutContent() {
  const params = useParams<{ tier: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const tier = String(params.tier || '').toLowerCase();
  const data = TIER_DATA[tier];
  const canceled = search.get('canceled') === '1';

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>('');
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    // Cheap auth probe — hit /api/auth/rancher/session (existing endpoint)
    fetch('/api/auth/rancher/session', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        setAuthed(!!j?.authenticated);
        setAuthChecked(true);
      })
      .catch(() => setAuthChecked(true));
  }, []);

  const startCheckout = async () => {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/rancher/tier/select', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      const j = await res.json();
      if (!res.ok) {
        if (res.status === 409 && j?.error?.includes('already active')) {
          // Already subscribed — push to billing
          router.push('/rancher/billing');
          return;
        }
        setError(j?.error || 'Checkout failed');
        setSubmitting(false);
        return;
      }
      if (j?.url) {
        window.location.href = j.url;
      } else {
        setError('No checkout URL returned');
        setSubmitting(false);
      }
    } catch (e: any) {
      setError(e?.message || 'Network error');
      setSubmitting(false);
    }
  };

  if (!data) {
    return (
      <div className="min-h-screen bg-bone text-charcoal p-8">
        <p>Unknown tier. <Link href="/partner" className="underline">See plans →</Link></p>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="max-w-2xl mx-auto px-6 py-12">
        <Link href="/partner" className="text-saddle text-sm hover:underline">← Back to plans</Link>

        <h1 className="text-4xl mt-4 mb-2" style={{ fontFamily: 'Georgia, serif' }}>
          You're about to start <span className="text-charcoal">{data.label}</span>
        </h1>
        <p className="text-saddle mb-8 text-lg">
          ${data.monthly}/mo + {data.rate}% commission · {data.promise}
        </p>

        {canceled && (
          <div className="border border-dust bg-bone p-4 mb-6 text-saddle text-sm">
            Checkout canceled. No charge made. Click below to try again when ready.
          </div>
        )}

        <div className="bg-white border border-dust p-6 mb-8">
          <h2 className="text-xl mb-4" style={{ fontFamily: 'Georgia, serif' }}>
            Here's what happens in the next 5 minutes:
          </h2>
          <ol className="space-y-3 text-charcoal">
            <li><span className="text-saddle">1.</span> You pay your first month (${data.monthly}) — Stripe Checkout (next screen)</li>
            <li><span className="text-saddle">2.</span> We create your Stripe Connect account so you can receive buyer payments</li>
            <li><span className="text-saddle">3.</span> You verify identity + bank account at Stripe (~5 min)</li>
            <li><span className="text-saddle">4.</span> We email you when you're live (usually under 30 minutes)</li>
            <li><span className="text-saddle">5.</span> Buyers in your state start matching automatically</li>
          </ol>
        </div>

        {!authChecked ? (
          <p className="text-saddle">Checking session…</p>
        ) : !authed ? (
          <div>
            <p className="text-saddle mb-4">You need a rancher account first.</p>
            <Link
              href={`/rancher/login?return=${encodeURIComponent(`/partner/checkout/${tier}`)}`}
              className="inline-block bg-charcoal text-bone px-8 py-3 uppercase tracking-wider text-sm hover:bg-saddle transition"
            >
              Log in / sign up →
            </Link>
          </div>
        ) : (
          <button
            onClick={startCheckout}
            disabled={submitting}
            className="bg-charcoal text-bone px-8 py-4 uppercase tracking-wider text-sm hover:bg-saddle transition disabled:opacity-50"
          >
            {submitting ? 'Redirecting to Stripe…' : 'Continue to Stripe Checkout →'}
          </button>
        )}

        {error && <p className="text-red-700 mt-4 text-sm">{error}</p>}

        <p className="text-saddle text-xs mt-8">
          Powered by Stripe · BuyHalfCow doesn't store card data · Cancel anytime
        </p>
      </div>
    </main>
  );
}
