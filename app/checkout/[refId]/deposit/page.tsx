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
import { REFUND_POLICY_SHORT } from '@/lib/refundPolicy';

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
  // Machine error CODE from the API (not the raw message) so the render maps it
  // to warm, actionable copy — never a raw Stripe/dev string to the buyer.
  const [errCode, setErrCode] = useState('');
  const [errSlug, setErrSlug] = useState(''); // rancher slug from an error payload (e.g. referral_closed)
  const [selectedCut, setSelectedCut] = useState<string>('half');
  const [submitting, setSubmitting] = useState(false);
  // F2/A4 — explicit ToS + refund-policy acceptance at the payment point.
  // The pay CTA stays disabled until checked; the POST requires it (400
  // terms_required otherwise), so acceptance is recorded at create time.
  const [termsAccepted, setTermsAccepted] = useState(false);

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
        if (j?.error) {
          setErrCode(String(j.error));
          if (j.rancherSlug) setErrSlug(String(j.rancherSlug));
          setError(String(j.message || j.error));
        } else {
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
      .catch(() => { setErrCode('load_failed'); setError('load_failed'); setLoading(false); });
  }, [refId, cutParam]);

  const continueToCheckout = async () => {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/checkout/deposit', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ referralId: refId, cutSize: selectedCut, termsAccepted }),
      });
      const j = await res.json();
      if (!res.ok) {
        if (j?.error === 'legacy_rancher' && j?.redirectUrl) {
          window.location.href = j.redirectUrl;
          return;
        }
        if (j?.rancherSlug) setErrSlug(String(j.rancherSlug));
        setErrCode(String(j?.error || 'checkout_failed'));
        setError(String(j?.message || j?.error || 'checkout_failed'));
        setSubmitting(false);
        return;
      }
      if (j?.url) {
        window.location.href = j.url;
      } else {
        setErrCode('checkout_failed');
        setError('no checkout url');
        setSubmitting(false);
      }
    } catch {
      setErrCode('network');
      setError('network');
      setSubmitting(false);
    }
  };

  if (loading) return (
    <div className="min-h-screen bg-bone text-charcoal flex items-center justify-center p-8">
      <p className="text-saddle">loading your reservation…</p>
    </div>
  );

  // Never render a raw API/Stripe error to a buyer, and never dead-end. Map the
  // machine error code to warm copy + a forward path (retry / sign-in / storefront).
  if (error || !info) {
    const code = String(errCode || error).toLowerCase();
    const storefrontHref = errSlug ? `/ranchers/${errSlug}` : '/ranchers';
    const Shell = ({ children }: { children: React.ReactNode }) => (
      <div className="min-h-screen bg-bone text-charcoal flex items-center justify-center p-6">
        <div className="w-full max-w-md text-center space-y-5">{children}</div>
      </div>
    );
    // Primary escape hatch is the on-site support intake (prefills ?ref so
    // the report arrives with the reservation attached); mailto stays as the
    // secondary path for buyers who just want their mail app.
    const supportLink = (
      <>
        <Link href={`/support?ref=${encodeURIComponent(refId)}`} className="underline text-saddle text-sm">get help and we&apos;ll sort it</Link>
        {' '}or email <a href="mailto:hello@buyhalfcow.com" className="underline text-saddle text-sm">hello@buyhalfcow.com</a>
      </>
    );

    // A4 — already reserved: a positive state, not an error.
    if (code.includes('referral_closed') || code.includes('already')) {
      return (
        <Shell>
          <h1 className="font-serif text-2xl">you&apos;re already reserved ✓</h1>
          <p className="text-saddle">your spot is locked in. we emailed your receipt — you&apos;re all set.</p>
          <div className="flex flex-col gap-2">
            <Link href={`/checkout/${refId}/preferences`} className="px-6 py-3 bg-charcoal text-bone text-sm uppercase tracking-wide">set your preferences →</Link>
            <Link href={`/checkout/${refId}/ask`} className="underline text-saddle text-sm">message your rancher</Link>
          </div>
        </Shell>
      );
    }

    // A2 — auth: session expired / not this account. Send them to sign in and
    // come right back to finish, never a bare "Not authenticated".
    if (code.includes('auth') || code.includes('forbidden') || code.includes('sign in') || code.includes('401') || code.includes('403')) {
      return (
        <Shell>
          <h1 className="font-serif text-2xl">sign in to finish reserving</h1>
          <p className="text-saddle">your link expired or you&apos;re signed out. sign in and we&apos;ll drop you right back here.</p>
          <Link href={`/member/login?next=${encodeURIComponent(`/checkout/${refId}/deposit${cutParam ? `?cut=${cutParam}` : ''}`)}`} className="px-6 py-3 bg-charcoal text-bone text-sm uppercase tracking-wide inline-block">sign in →</Link>
          <p className="text-xs text-saddle">still stuck? {supportLink}.</p>
        </Shell>
      );
    }

    // not found
    if (code.includes('not_found') || code.includes('not found')) {
      return (
        <Shell>
          <h1 className="font-serif text-2xl">we couldn&apos;t find this reservation</h1>
          <p className="text-saddle">the link may be old. pick your rancher and reserve fresh — takes a minute.</p>
          <Link href={storefrontHref} className="px-6 py-3 bg-charcoal text-bone text-sm uppercase tracking-wide inline-block">find your rancher →</Link>
          <p className="text-xs text-saddle">{supportLink}.</p>
        </Shell>
      );
    }

    // A1 — generic failure (checkout create / network / load). Card was NOT
    // charged; offer a real retry + a human. Retry re-runs checkout when the
    // reservation loaded, else reloads the page.
    return (
      <Shell>
        <h1 className="font-serif text-2xl">hmm — that didn&apos;t go through</h1>
        <p className="text-saddle">your card wasn&apos;t charged. give it another try — these things are usually a quick blip.</p>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => { setError(''); setErrCode(''); if (info) { continueToCheckout(); } else { window.location.reload(); } }}
            className="px-6 py-3 bg-charcoal text-bone text-sm uppercase tracking-wide"
          >try again</button>
          <Link href={`/checkout/${refId}/ask`} className="underline text-saddle text-sm">message your rancher instead</Link>
        </div>
        <p className="text-xs text-saddle">still not working? {supportLink}.</p>
      </Shell>
    );
  }

  if (!info.tierConnected) {
    // B3 — don't leave a ready-to-pay buyer at a message-only dead-end. Give
    // them a reason to stay (we'll hold + email), plus two live forward paths.
    return (
      <div className="min-h-screen bg-bone text-charcoal flex items-center justify-center p-6">
        <div className="w-full max-w-md text-center space-y-5">
          <h1 className="font-serif text-2xl">
            {info.rancher.name} is finishing their bank setup
          </h1>
          <p className="text-saddle">
            usually a day or two. want us to hold your spot and email you the second
            they can take your deposit? just reply to your intro email and we&apos;ve got you —
            or lock it in faster on a quick call with ben.
          </p>
          <div className="flex flex-col gap-2">
            <a href={BEN_SALES_CAL_URL} className="px-6 py-3 bg-charcoal text-bone text-sm uppercase tracking-wide">book a 15-min call with ben →</a>
            <Link href={`/checkout/${refId}/ask`} className="underline text-saddle text-sm">message {info.rancher.name} instead</Link>
          </div>
        </div>
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
        <Link href={`/checkout/${refId}/ask`} className="text-saddle text-sm hover:underline">have a question? message your rancher →</Link>

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
              the BuyHalfCow promise
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

        {/* The deposit decision point. One thing looks like a button (the
            deposit); the call is a recessive text link below it, never a peer.
            Honest scarcity (real next-processing date) sits just above; the
            trust line (refund + stripe) sits just below where anxiety peaks.
            On mobile this whole block sticks to the thumb zone so the deposit
            is always one reach away on a long page.

            bottom: var(--consent-h) — while the first-visit consent banner is
            on screen it publishes its height on <html>; sticking this block
            that many px up keeps the PAY button fully visible above the
            banner instead of covered by it (the exact buyer every ad click
            sends is first-visit + mobile). 0px once a consent choice is made.
            Inert on desktop (md:static ignores bottom). */}
        <div className="sticky -mx-4 md:mx-0 px-4 md:px-0 pt-3 pb-4 md:pb-0 md:static bg-bone md:bg-transparent border-t border-divider md:border-0" style={{ bottom: 'var(--consent-h, 0px)' }}>
          {/* error surfaces here, above the button, so it's never hidden under
              the sticky block on mobile */}
          {error && <p className="text-red-700 mb-2 text-sm text-center">{error}</p>}

          {/* honest scarcity — real processing date only, never a fake count */}
          {info.fulfillment.nextProcessingDate && (
            <p className="text-center text-sm text-charcoal mb-2">
              next processing date: <strong>{info.fulfillment.nextProcessingDate}</strong> — reserve before it fills
            </p>
          )}

          {/* F2/A4 consent — required checkbox directly above the pay CTA so
              acceptance happens AT the payment point. Copy pulls
              REFUND_POLICY_SHORT from lib/refundPolicy (single source — never
              hand-write the policy here). */}
          <label className="flex items-start gap-3 mb-3 cursor-pointer">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
              className="mt-1 w-4 h-4 accent-charcoal cursor-pointer shrink-0"
            />
            <span className="text-sm text-charcoal/85 leading-relaxed">
              I agree to the{' '}
              <a
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-saddle"
              >
                Terms of Service
              </a>{' '}
              and the refund policy: {REFUND_POLICY_SHORT}.
            </span>
          </label>

          <button
            onClick={continueToCheckout}
            disabled={submitting || !selectedCutData || !termsAccepted}
            className="w-full bg-charcoal text-bone px-4 md:px-8 py-4 min-h-[48px] text-base hover:bg-saddle transition disabled:opacity-50 flex items-center justify-center"
          >
            {submitting
              ? 'redirecting to stripe…'
              : selectedCutData
                ? `reserve your ${selectedCutData.label.toLowerCase()} — secure deposit →`
                : 'reserve your share — secure deposit →'}
          </button>

          {/* trust line — directly under the button, where deposit anxiety peaks */}
          <p className="text-saddle text-xs mt-2 text-center leading-relaxed">
            fully refundable until {info.rancher.name} accepts · secured by stripe · we don&apos;t store card data
          </p>

          {/* recessive escape hatch — plain text link, never a second button */}
          <p className="text-center mt-3">
            <a
              href={BEN_SALES_CAL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-saddle text-sm underline hover:text-charcoal"
            >
              or book a 15-min call with ben first
            </a>
          </p>
        </div>

        <div className="mt-8 pt-6 border-t border-divider text-center">
          <Link href={`/checkout/${refId}/ask`} className="text-saddle text-sm hover:underline">
            have questions first? message {info.rancher.name} →
          </Link>
        </div>
      </div>
    </main>
  );
}
