'use client';

// Stage-3 Task 8 — buyer deposit page.
// Renders rancher's fulfillment info + refund policy + cut selector
// + Continue to Stripe Checkout button. Fires POST /api/checkout/deposit.

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';

interface Cut { slug: string; label: string; price: number | null; lbs: string; }
interface DepositInfo {
  rancher: { name: string; ranchName: string; slug: string; state: string };
  pricingModel: string;
  tierConnected: boolean;
  legacyRedirectUrl: string | null;
  cuts: Cut[];
  fulfillment: {
    types: string[];
    pickupCity: string;
    deliveryRadiusMiles: number | null;
    shippingLeadTimeDays: number | null;
    costNotes: string;
    nextProcessingDate: string;
  };
  refundPolicy: string;
}

export default function DepositPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bg text-text-primary flex items-center justify-center"><p>Loading checkout…</p></div>}>
      <DepositPageContent />
    </Suspense>
  );
}

function DepositPageContent() {
  const params = useParams<{ refId: string }>();
  const search = useSearchParams();
  const refId = params.refId;
  const canceled = search.get('canceled') === '1';

  const [info, setInfo] = useState<DepositInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedCut, setSelectedCut] = useState<string>('half');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/checkout/deposit?refId=${encodeURIComponent(refId)}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (j?.error) setError(j.error);
        else {
          setInfo(j);
          // Auto-redirect if legacy
          if (j.pricingModel === 'legacy' && j.legacyRedirectUrl) {
            window.location.href = j.legacyRedirectUrl;
            return;
          }
          // Default cut: half if available
          if (j.cuts?.find((c: Cut) => c.slug === 'half')) setSelectedCut('half');
          else if (j.cuts?.length) setSelectedCut(j.cuts[0].slug);
        }
        setLoading(false);
      })
      .catch((e) => { setError(e?.message || 'Load failed'); setLoading(false); });
  }, [refId]);

  const continueToCheckout = async () => {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/checkout/deposit', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ referralId: refId, cutSize: selectedCut }),
      });
      const j = await res.json();
      if (!res.ok) {
        if (j?.error === 'legacy_rancher' && j?.redirectUrl) {
          window.location.href = j.redirectUrl;
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

  if (loading) return <div className="min-h-screen bg-bone text-charcoal p-8">Loading…</div>;
  if (error || !info) return (
    <div className="min-h-screen bg-bone text-charcoal p-8">
      <p>{error || 'No data'}</p>
      <Link href="/member" className="underline text-saddle">← Your dashboard</Link>
    </div>
  );

  if (!info.tierConnected) {
    return (
      <div className="min-h-screen bg-bone text-charcoal p-8">
        <h1 className="text-2xl mb-4" style={{ fontFamily: 'Georgia, serif' }}>
          {info.rancher.name} isn&apos;t quite ready to accept deposits here
        </h1>
        <p className="text-saddle mb-4">
          They&apos;re finishing setting up payments. We&apos;ll email you the moment they&apos;re ready.
        </p>
        <Link href={`/checkout/${refId}/ask`} className="underline text-saddle">
          Message {info.rancher.name} in the meantime →
        </Link>
      </div>
    );
  }

  const selectedCutData = info.cuts.find((c) => c.slug === selectedCut);
  const fmtUsd = (price: number | null) => price == null ? '' : `$${price.toLocaleString()}`;

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="max-w-2xl mx-auto px-6 py-10">
        <Link href={`/checkout/${refId}/ask`} className="text-saddle text-sm hover:underline">← Back to thread</Link>

        <h1 className="text-4xl mt-4 mb-2" style={{ fontFamily: 'Georgia, serif' }}>
          Reserve your beef
        </h1>
        <p className="text-saddle mb-8">
          Rancher · <strong>{info.rancher.ranchName || info.rancher.name}</strong>{info.rancher.state ? ` · ${info.rancher.state}` : ''}
        </p>

        {canceled && (
          <div className="border border-dust bg-bone p-3 mb-6 text-saddle text-sm">
            Checkout canceled. No charge made.
          </div>
        )}

        {/* Cut selector */}
        <div className="mb-6">
          <div className="text-xs text-saddle uppercase tracking-wider mb-2">Pick your cut</div>
          <div className="grid grid-cols-3 gap-3">
            {info.cuts.map((c) => {
              const selected = selectedCut === c.slug;
              return (
                <button
                  key={c.slug}
                  onClick={() => setSelectedCut(c.slug)}
                  className={`p-4 text-left border-2 ${selected ? 'border-charcoal' : 'border-dust'} bg-white hover:border-saddle transition`}
                >
                  <div className="text-sm">{c.label}</div>
                  <div className="text-lg" style={{ fontFamily: 'Georgia, serif' }}>{fmtUsd(c.price)}</div>
                  {c.lbs && <div className="text-xs text-saddle">~{c.lbs}</div>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Before you pay */}
        <div className="border-t border-divider pt-6 mb-6">
          <div className="text-xs text-saddle uppercase tracking-wider mb-3">Before you pay</div>

          {/* How you get it */}
          <div className="bg-white border border-dust p-4 mb-3">
            <div className="text-xs uppercase tracking-wider text-saddle mb-2">How you get it</div>
            <div className="text-sm">
              {info.fulfillment.types.length === 0 ? (
                <p className="text-saddle">Pickup/delivery coordinated with rancher after deposit.</p>
              ) : (
                <p>
                  {info.fulfillment.types.join(' · ')}
                  {info.fulfillment.types.includes('Local Pickup') && info.fulfillment.pickupCity && (
                    <> · Pickup at <strong>{info.fulfillment.pickupCity}</strong></>
                  )}
                  {info.fulfillment.types.includes('Local Delivery') && info.fulfillment.deliveryRadiusMiles && (
                    <> · Delivery within <strong>{info.fulfillment.deliveryRadiusMiles} mi</strong></>
                  )}
                  {info.fulfillment.types.includes('Cold-Chain Shipping') && info.fulfillment.shippingLeadTimeDays && (
                    <> · Ships in ~<strong>{info.fulfillment.shippingLeadTimeDays} days</strong> after processing</>
                  )}
                  {info.fulfillment.nextProcessingDate && (
                    <> · Next processing: <strong>{info.fulfillment.nextProcessingDate}</strong></>
                  )}
                </p>
              )}
              {info.fulfillment.costNotes && (
                <p className="text-saddle text-xs mt-2">Extras: {info.fulfillment.costNotes}</p>
              )}
            </div>
          </div>

          {/* BHC Promise — platform-level trust floor (cold-chain + 7-day satisfaction + mediation).
              Lives ABOVE the rancher's self-written policy so a "NO REFUNDS EVER" line doesn't tank
              buyer trust right before the Continue-to-Stripe button. See docs/BHC-PROMISE.md. */}
          <div className="border-l-4 border-sage-dark bg-white p-6 mb-3">
            <h2 className="font-serif text-lg uppercase tracking-widest text-sage-dark mb-3">
              <span aria-hidden="true">🛡️</span> BHC Promise
            </h2>
            <p className="text-sm text-charcoal leading-relaxed mb-4">
              Beef arrives frozen and on time, or BHC refunds your deposit within 7 days — no questions asked, paid by BuyHalfCow.
            </p>
            <ul className="text-sm text-charcoal leading-relaxed space-y-2">
              <li className="flex gap-2">
                <span className="text-sage-dark" aria-hidden="true">•</span>
                <span><strong>Cold-chain guarantee:</strong> if your beef arrives thawed, it&apos;s free.</span>
              </li>
              <li className="flex gap-2">
                <span className="text-sage-dark" aria-hidden="true">•</span>
                <span><strong>7-day satisfaction:</strong> not what you expected? Full deposit refund.</span>
              </li>
              <li className="flex gap-2">
                <span className="text-sage-dark" aria-hidden="true">•</span>
                <span><strong>We mediate:</strong> any dispute, reply to your match thread or email <a href="mailto:hello@buyhalfcow.com" className="underline">hello@buyhalfcow.com</a> and we step in.</span>
              </li>
            </ul>
          </div>

          {/* Refund policy — rancher's own (applies above and beyond the BHC Promise floor above) */}
          {info.refundPolicy && (
            <div className="bg-white border border-dust p-4 mb-3">
              <div className="text-xs uppercase tracking-wider text-saddle mb-2">Rancher&apos;s refund policy</div>
              <p className="text-sm whitespace-pre-wrap">{info.refundPolicy}</p>
              <p className="text-xs text-saddle italic mt-3">
                Above and beyond BHC&apos;s Promise, {info.rancher.name}&apos;s own policy applies. For disputes, reply to your match thread — BuyHalfCow can mediate.
              </p>
            </div>
          )}

          {/* How payment works */}
          <div className="bg-white border border-dust p-4">
            <div className="text-xs uppercase tracking-wider text-saddle mb-2">How the payment works</div>
            <p className="text-sm">
              Your {selectedCutData ? fmtUsd(selectedCutData.price) : ''} goes to {info.rancher.name} through Stripe. We hold no funds at BuyHalfCow. {info.rancher.name} ships/delivers/has you pick up. You + {info.rancher.name} coordinate details by message — we already have a thread open for you.
            </p>
          </div>
        </div>

        <button
          onClick={continueToCheckout}
          disabled={submitting || !selectedCutData}
          className="w-full bg-charcoal text-bone px-8 py-4 uppercase tracking-wider text-sm hover:bg-saddle transition disabled:opacity-50"
        >
          {submitting ? 'Redirecting to Stripe…' : 'Continue to Secure Payment →'}
        </button>

        <p className="text-saddle text-xs mt-4 text-center">
          Powered by Stripe · BuyHalfCow doesn&apos;t store card data
        </p>

        {error && <p className="text-red-700 mt-4 text-sm">{error}</p>}

        <div className="mt-8 pt-6 border-t border-divider text-center">
          <Link href={`/checkout/${refId}/ask`} className="text-saddle text-sm hover:underline">
            Have questions first? Message {info.rancher.name} →
          </Link>
        </div>
      </div>
    </main>
  );
}
