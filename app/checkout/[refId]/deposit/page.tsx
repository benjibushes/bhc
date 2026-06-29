'use client';

// Stage-3 Task 8 — buyer deposit page.
// Renders rancher's fulfillment info + refund policy + cut selector
// + Continue to Stripe Checkout button. Fires POST /api/checkout/deposit.

import { Suspense, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { trackEvent, metaEventId } from '@/lib/analytics';
import { CutBreakdown, type Tier } from '@/app/components/CutBreakdown';
import { BEN_SALES_CAL_URL } from '@/lib/salesContact';

// Map deposit cut slug → CutBreakdown tier. Slug is lowercase from
// Stripe Price metadata; tier is the capitalized human-readable label.
function slugToTier(slug: string): Tier | null {
  const s = (slug || '').toLowerCase();
  if (s === 'quarter') return 'Quarter';
  if (s === 'half') return 'Half';
  if (s === 'whole') return 'Whole';
  return null;
}

interface Cut {
  slug: string;
  label: string;
  price: number | null;
  lbs: string;
  // Money breakdown (cents) from GET /api/checkout/deposit. The buyer's card is
  // charged dueNowCents = depositCents + feeCents (fee ADDED ON TOP of deposit).
  // balanceCents is paid rancher-direct at pickup. Null on legacy/unpriced cuts.
  depositCents?: number | null;
  feeCents?: number | null;
  dueNowCents?: number | null;
  balanceCents?: number | null;
}
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
    <Suspense fallback={<div className="min-h-screen bg-bone text-charcoal flex items-center justify-center"><p>Loading checkout…</p></div>}>
      <DepositPageContent />
    </Suspense>
  );
}

function DepositPageContent() {
  const params = useParams<{ refId: string }>();
  const search = useSearchParams();
  const refId = params.refId;
  const canceled = search.get('canceled') === '1';
  const cutParam = search.get('cut'); // pre-select cut from the reserve fast-path

  const [info, setInfo] = useState<DepositInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedCut, setSelectedCut] = useState<string>('half');
  const [submitting, setSubmitting] = useState(false);

  // G4 — deposit_initiated client Pixel fire on page mount. Server-side
  // CAPI InitiateCheckout fires from /api/checkout/deposit POST (F5);
  // this pairs via refId-scoped event_id so Meta can dedup.
  // Idempotency guard prevents re-fire if React re-mounts the effect.
  //
  // E-3 audit fix: event_id MUST equal what server CAPI sends (raw referralId
  // at /api/checkout/deposit:224). Prior `deposit_initiated:${refId}` prefix
  // broke dedup — Meta saw two distinct events instead of one.
  const depositInitiatedFired = useRef(false);
  useEffect(() => {
    if (depositInitiatedFired.current || !refId) return;
    depositInitiatedFired.current = true;
    trackEvent('deposit_initiated', {
      refId,
      event_id: metaEventId(refId),
    });
  }, [refId]);

  useEffect(() => {
    fetch(`/api/checkout/deposit?refId=${encodeURIComponent(refId)}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (j?.error) setError(j.message || j.error);
        else {
          setInfo(j);
          // Auto-redirect if legacy
          if (j.pricingModel === 'legacy' && j.legacyRedirectUrl) {
            window.location.href = j.legacyRedirectUrl;
            return;
          }
          // Pre-select the cut passed via ?cut= (reserve fast-path) so the buyer
          // doesn't re-pick; else default to half, else first available.
          if (cutParam && j.cuts?.find((c: Cut) => c.slug === cutParam)) setSelectedCut(cutParam);
          else if (j.cuts?.find((c: Cut) => c.slug === 'half')) setSelectedCut('half');
          else if (j.cuts?.length) setSelectedCut(j.cuts[0].slug);
        }
        setLoading(false);
      })
      .catch((e) => { setError(e?.message || 'Load failed'); setLoading(false); });
  }, [refId, cutParam]);

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
        setError(j?.message || j?.error || 'Checkout failed');
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
      <div className="min-h-screen bg-bone text-charcoal p-4 md:p-8">
        <h1 className="text-xl md:text-2xl mb-4 font-serif">
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
  // Round-dollar formatter for the cents fields from the API (deposit/fee/
  // balance/dueNow). Brand rule: clean round dollars, never .99 — round to the
  // nearest dollar then reuse fmtUsd's comma grouping. Stays free of any new
  // helper import.
  const fmtCents = (cents: number | null | undefined) =>
    cents == null ? '' : fmtUsd(Math.round(cents / 100));

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="max-w-2xl mx-auto px-4 md:px-6 py-6 md:py-10">
        <Link href={`/checkout/${refId}/ask`} className="text-saddle text-sm hover:underline">← Back to thread</Link>

        <h1 className="text-2xl md:text-4xl mt-4 mb-2 font-serif">
          Reserve your beef
        </h1>
        <p className="text-saddle mb-6">
          From <strong>{info.rancher.ranchName || info.rancher.name}</strong>{info.rancher.state ? ` in ${info.rancher.state}` : ''} · raised direct
        </p>

        {/* Rancher trust card — name + state + verified pin. Photo + certifications
            not surfaced via API yet; keep it minimal + honest. */}
        <div className="bg-white border border-dust p-3 md:p-4 mb-6 flex items-center gap-3">
          <div className="w-10 h-10 md:w-12 md:h-12 flex-shrink-0 bg-sage-dark text-bone flex items-center justify-center font-serif text-lg" aria-hidden="true">
            {(info.rancher.name || 'R').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{info.rancher.name}</div>
            <div className="text-xs text-saddle">
              {info.rancher.ranchName ? `${info.rancher.ranchName} · ` : ''}{info.rancher.state || 'Verified ranch'} · personally certified by Ben
            </div>
          </div>
        </div>

        {canceled && (
          <div className="border border-dust bg-bone p-3 mb-6 text-saddle text-sm">
            Checkout canceled. No charge made.
          </div>
        )}

        {/* Cut selector */}
        <div className="mb-6">
          <div id="cut-selector-label" className="text-xs text-saddle uppercase tracking-wider mb-2">Pick your cut</div>
          <div role="radiogroup" aria-labelledby="cut-selector-label" className="grid grid-cols-1 md:grid-cols-3 gap-2 md:gap-3">
            {info.cuts.map((c) => {
              const selected = selectedCut === c.slug;
              return (
                <button
                  key={c.slug}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setSelectedCut(c.slug)}
                  className={`relative p-3 md:p-4 text-left border-2 ${selected ? 'border-charcoal ring-1 ring-charcoal' : 'border-dust'} bg-white hover:border-saddle transition`}
                >
                  {selected && (
                    <span
                      className="absolute top-2 right-2 w-5 h-5 flex items-center justify-center bg-charcoal text-bone text-xs leading-none"
                      aria-hidden="true"
                    >
                      ✓
                    </span>
                  )}
                  <div className="text-sm">{c.label}</div>
                  <div className="text-lg md:text-xl font-serif">{fmtUsd(c.price)}</div>
                  {c.lbs && <div className="text-xs text-saddle">~{c.lbs}</div>}
                </button>
              );
            })}
          </div>
        </div>

        {/* What you actually get — concrete cut breakdown + cost-per-serving
            framing. Converts the deposit number from "expensive" into
            "actually cheap per dinner." Drops when cut isn't quarter/half/whole
            (e.g., custom cut sheets) — avoids fake numbers. */}
        {(() => {
          const tier = selectedCutData ? slugToTier(selectedCutData.slug) : null;
          if (!tier) return null;
          return (
            <div className="mb-6">
              <CutBreakdown tier={tier} totalCost={selectedCutData?.price || undefined} />
            </div>
          );
        })()}

        {/* Before you pay */}
        <div className="border-t border-divider pt-6 mb-6">
          <div className="text-xs text-saddle uppercase tracking-wider mb-3">Before you pay</div>

          {/* How you get it */}
          <div className="bg-white border border-dust p-3 md:p-4 mb-3">
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

          {/* BHC Promise — platform-level trust floor. Updated 2026-06-05 NRD policy:
              deposit is REFUNDABLE until rancher accepts your slot, then non-refundable.
              Cold-chain guarantee + mediation stay regardless. */}
          <div className="border-l-4 border-sage-dark bg-white p-3 md:p-6 mb-3">
            <h2 className="font-serif text-lg uppercase tracking-widest text-sage-dark mb-3">
              <span aria-hidden="true">🛡️</span> BHC Promise
            </h2>
            <p className="text-sm text-charcoal leading-relaxed mb-4">
              Your deposit reserves your slot with {info.rancher.name}. It&rsquo;s fully refundable until they accept it — usually within 24–48 hours. Once they commit your processing slot, it becomes non-refundable.
            </p>
            <ul className="text-sm text-charcoal leading-relaxed space-y-2">
              <li className="flex gap-2">
                <span className="text-sage-dark" aria-hidden="true">•</span>
                <span><strong>Refundable window:</strong> change your mind before {info.rancher.name} accepts? Full refund, no questions.</span>
              </li>
              <li className="flex gap-2">
                <span className="text-sage-dark" aria-hidden="true">•</span>
                <span><strong>Non-refundable once accepted:</strong> after they commit your slot, they&rsquo;ve set aside cuts of meat and locked in processing. You&rsquo;ll get a &ldquo;slot locked&rdquo; email the moment that happens.</span>
              </li>
              <li className="flex gap-2">
                <span className="text-sage-dark" aria-hidden="true">•</span>
                <span><strong>Cold-chain guarantee stays:</strong> if your beef arrives thawed or short, BHC makes you whole — even after acceptance.</span>
              </li>
              <li className="flex gap-2">
                <span className="text-sage-dark" aria-hidden="true">•</span>
                <span><strong>We mediate:</strong> any dispute, reply to your match thread or email <a href="mailto:hello@buyhalfcow.com" className="underline">hello@buyhalfcow.com</a> and we step in.</span>
              </li>
            </ul>
          </div>

          {/* Refund policy — rancher's own (applies above and beyond the BHC Promise floor above) */}
          {info.refundPolicy && (
            <div className="bg-white border border-dust p-3 md:p-4 mb-3">
              <div className="text-xs uppercase tracking-wider text-saddle mb-2">Rancher&apos;s refund policy</div>
              <p className="text-sm whitespace-pre-wrap">{info.refundPolicy}</p>
              <p className="text-xs text-saddle italic mt-3">
                Above and beyond BHC&apos;s Promise, {info.rancher.name}&apos;s own policy applies. For disputes, reply to your match thread — BuyHalfCow can mediate.
              </p>
            </div>
          )}

          {/* What you pay today — itemized. Buyer's card is charged
              deposit + BHC service fee (fee ADDED ON TOP, mirrors the API +
              Stripe line items). Balance is paid rancher-direct at pickup.
              Replaces the old "commission off the top" copy, which was false:
              the fee is added on top, so the card is charged MORE than the
              share price, not less. */}
          <div className="bg-white border border-dust p-3 md:p-4">
            <div className="text-xs uppercase tracking-wider text-saddle mb-3">What you pay today</div>
            {selectedCutData && selectedCutData.dueNowCents != null ? (
              <>
                <div className="text-sm space-y-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span>Reserve your {selectedCutData.label.toLowerCase()}</span>
                    <span className="font-medium whitespace-nowrap">{fmtCents(selectedCutData.depositCents)}</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <span>BuyHalfCow service fee</span>
                    <span className="font-medium whitespace-nowrap">{fmtCents(selectedCutData.feeCents)}</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-3 border-t border-dust pt-2 font-serif text-lg">
                    <span>Due today</span>
                    <span className="whitespace-nowrap">{fmtCents(selectedCutData.dueNowCents)}</span>
                  </div>
                </div>
                <p className="text-sm text-saddle mt-3 leading-relaxed">
                  Remaining <strong className="text-charcoal">{fmtCents(selectedCutData.balanceCents)}</strong> is paid directly to {info.rancher.name} at pickup — not now.
                </p>
                <p className="text-xs text-saddle mt-3 leading-relaxed">
                  Your {fmtCents(selectedCutData.depositCents)} reserve routes to {info.rancher.name} through Stripe; the {fmtCents(selectedCutData.feeCents)} service fee is BuyHalfCow&apos;s commission, added on top so the rancher keeps their full price. That&apos;s how we stay free for buyers — the rancher pays the commission, never you on top of the beef. {info.rancher.name} handles pickup, delivery, or shipping; you two coordinate the details in your message thread.
                </p>
              </>
            ) : (
              <p className="text-sm text-saddle leading-relaxed">
                Your reserve routes to {info.rancher.name} through Stripe, plus a small BuyHalfCow service fee shown at checkout. The rancher pays our commission — that&apos;s how we stay free for buyers. {info.rancher.name} handles pickup, delivery, or shipping; you two coordinate the details in your message thread.
              </p>
            )}
          </div>
        </div>

        <button
          onClick={continueToCheckout}
          disabled={submitting || !selectedCutData}
          className="w-full bg-charcoal text-bone px-4 md:px-8 py-3 md:py-4 min-h-[48px] uppercase tracking-wider text-sm hover:bg-saddle transition disabled:opacity-50 flex items-center justify-center"
        >
          {submitting ? 'Redirecting to Stripe…' : 'Continue to Secure Payment →'}
        </button>

        <p className="text-center mt-3">
          <a
            href={BEN_SALES_CAL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-saddle text-sm underline hover:text-charcoal"
          >
            prefer to talk it through first? book a 15-min call
          </a>
        </p>

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
