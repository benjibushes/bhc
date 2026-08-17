'use client';

// Self-serve reserve form for a BROKER (represented) ranch with the
// `Broker Self Serve` opt-in — the public-page half of
// POST /api/checkout/broker-reserve. Renders per-cut cards from the
// server-computed view model (lib/brokerSelfServe — the SAME
// assertBrokerEligible gate the checkout runs, so a card can never bounce at
// pay), collects cut + name + email + phone, and navigates to the broker
// checkout path the API returns.
//
// COPY CONTRACT (docs/BUSINESS-MODEL.md model 3): the deposit is "toward your
// share"; the balance is "paid to the ranch". Nothing here may say commission
// or fee, and none of the Connect rail's framing ("keep 100%… fee on top")
// applies — on this rail the buyer's total is simply the ranch's price.
// WEIGHT-PRICED cuts state "estimated $floor–$max", never an exact total or
// balance; the deposit stays exact in both modes.
//
// Failures stay INLINE. The Connect form's /access quiz fallback is deliberately
// absent: a represented ranch is outside routing/matching, so handing this
// buyer to the quiz would strand them on a rail that can never reach this
// ranch. Same-tab navigation only (window.location.href — window.open after an
// await is silently popup-blocked on mobile).

import { useState } from 'react';
import { track } from '@/lib/track';
import { readStoredAttribution, hasAdAttribution } from '@/lib/adAttribution';
import { BROKER_REFUND_POLICY_SHORT } from '@/lib/refundPolicy';
import { TermsNotice } from '@/app/components/SmsConsentCheckbox';
import type { BrokerCutCard } from '@/lib/brokerSelfServe';

interface Props {
  slug: string;
  ranchName: string;
  cards: BrokerCutCard[];
  /** How/when the balance is paid to the ranch (always present — fallback copy server-side). */
  balanceNote: string;
  /** '' unless a weight-priced cut exists. */
  pricingNote: string;
  /** [] = render nothing. */
  fulfillmentSteps: string[];
  /** '' = render nothing. */
  additionalCosts: string;
}

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

/** "$1,050–$1,225" — the honest estimated range for a weight-priced cut. */
function usdRange(minCents: number, maxCents: number): string {
  return `${usd(minCents)}–${usd(maxCents)}`;
}

export default function BrokerReserve({
  slug, ranchName, cards, balanceNote, pricingNote, fulfillmentSteps, additionalCosts,
}: Props) {
  // Default = half (brand namesake), falling back to the first sellable cut.
  const defaultCut = cards.find((c) => c.cut === 'half')?.cut || cards[0]?.cut || 'half';
  const [cut, setCut] = useState<string>(defaultCut);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const selected = cards.find((c) => c.cut === cut) || null;
  const steps = fulfillmentSteps.filter(Boolean);

  function pick(c: BrokerCutCard) {
    track('AddToCart', {
      content_name: ranchName, content_category: c.label,
      ranchSlug: slug, value: c.priceCents / 100, currency: 'USD',
    });
    setCut(c.cut);
    setError('');
  }

  async function reserve(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || loading) return;
    setLoading(true);
    setError('');
    // AD ATTRIBUTION (2026-08-17) — the first-touch snapshot UtmCapture writes
    // (bhc_source_v2), via the SAME shared parser the funnel uses. THIS is the
    // rail that needed it: it mints its own Consumer, so before this those rows
    // were created with no `fbclid` at all, reconstructFbc returned undefined,
    // and every broker deposit Purchase fired with no match key.
    //
    // READ AT SUBMIT, NOT AT MOUNT. UtmCapture lives in app/layout.tsx and this
    // form is inside {children}; React flushes child effects BEFORE parent
    // effects, so a mount-time read's correctness would hinge on the order of
    // two JSX lines in the layout. By submit time the capture has certainly
    // run. Total by contract — blocked/corrupt storage yields the all-empty
    // snapshot, so this can never gate or delay a reserve.
    const attribution = readStoredAttribution();
    try {
      const res = await fetch('/api/checkout/broker-reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          slug, cut: selected.cut, email, name, phone,
          // Omitted entirely when there is nothing to send. Server-side this is
          // CREATE-only — an adopted buyer keeps their original first touch.
          ...(hasAdAttribution(attribution) ? { attribution } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Inline, always — never a quiz handoff (this ranch is outside that
        // flow). `message` is the buyer-safe copy; bare `error` covers 400s.
        setError(j?.message || j?.error || 'Something went wrong — try again.');
        setLoading(false);
        return;
      }
      if (j?.redirect) {
        track('InitiateCheckout', {
          content_name: ranchName, ranchSlug: slug,
          value: selected.priceCents / 100, currency: 'USD',
        });
        window.location.href = j.redirect; // → /checkout/[refId]/broker?cut=…
      } else {
        setError('Could not start your reservation — try again.');
        setLoading(false);
      }
    } catch {
      setError('Network error — try again.');
      setLoading(false);
    }
  }

  if (cards.length === 0) return null;

  return (
    <div id="reserve" className="space-y-6 scroll-mt-20">
      <div className="grid sm:grid-cols-3 gap-4">
        {cards.map((c) => (
          <button
            key={c.cut}
            type="button"
            onClick={() => pick(c)}
            className={`border p-5 text-center transition-base ${
              cut === c.cut ? 'border-charcoal bg-charcoal text-bone' : 'border-dust bg-bone text-charcoal hover:border-charcoal'
            }`}
          >
            <p className={`text-xs uppercase tracking-widest ${cut === c.cut ? 'text-bone/70' : 'text-saddle'}`}>
              {c.label}
            </p>
            <p className="font-serif text-3xl mt-1">
              {c.weightPriced && c.priceMaxCents
                ? usdRange(c.priceCents, c.priceMaxCents)
                : usd(c.priceCents)}
            </p>
            {c.weightPriced ? (
              <p className={`text-xs mt-1 ${cut === c.cut ? 'text-bone/60' : 'text-muted'}`}>estimated total</p>
            ) : null}
            <p className={`text-xs mt-1 ${cut === c.cut ? 'text-bone/60' : 'text-muted'}`}>
              {usd(c.depositCents)} holds your {c.label.toLowerCase()}
            </p>
          </button>
        ))}
      </div>

      {/* Money picture for the selected cut — same framing as the broker
          checkout page, so nothing changes between this card and pay. */}
      {selected && (
        <div className="max-w-md mx-auto border border-dust bg-white p-5 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-saddle">{selected.label} — {selected.weightPriced ? 'share price' : 'total price'}</span>
            <span className="font-medium">
              {selected.weightPriced && selected.priceMaxCents
                ? `estimated ${usdRange(selected.priceCents, selected.priceMaxCents)}`
                : usd(selected.priceCents)}
            </span>
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-saddle">Deposit due today</span>
            <span className="font-serif text-2xl font-bold">{usd(selected.depositCents)}</span>
          </div>
          <hr className="my-3 border-dust" />
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-saddle">Balance you pay the ranch</span>
            <span className="font-medium">
              {selected.weightPriced && selected.balanceMaxCents
                ? `estimated ${usdRange(selected.balanceCents, selected.balanceMaxCents)}`
                : usd(selected.balanceCents)}
            </span>
          </div>
          <p className="mt-3 text-saddle leading-relaxed">
            Your deposit counts toward your share price.{' '}
            {selected.weightPriced && selected.balanceMaxCents
              ? `Your final price is set by hanging weight, so the balance you pay directly to ${ranchName} — not to BuyHalfCow — will land between ${usd(selected.balanceCents)} and ${usd(selected.balanceMaxCents)}. `
              : `You pay the remaining ${usd(selected.balanceCents)} directly to ${ranchName}, not to BuyHalfCow. `}
            {balanceNote}
          </p>
          {selected.weightPriced && pricingNote ? (
            <div className="mt-4 border border-dust bg-bone-warm p-3">
              <p className="text-xs uppercase tracking-wide text-saddle">How your final price is set</p>
              <p className="mt-1 whitespace-pre-line text-charcoal leading-relaxed">{pricingNote}</p>
            </div>
          ) : null}
        </div>
      )}

      {/* THIRD-PARTY COST DISCLOSURE — before the money moves, same as the
          checkout page. Renders only when the ranch actually has such a cost. */}
      {additionalCosts && (
        <div className="max-w-md mx-auto border-2 border-tallow-deep bg-tallow/20 p-5 rounded-sm">
          <h3 className="font-serif text-lg text-charcoal">One more cost, paid separately</h3>
          <p className="mt-2 whitespace-pre-line text-sm text-charcoal leading-relaxed">{additionalCosts}</p>
          <p className="mt-3 text-xs text-charcoal/85 leading-relaxed">
            You pay this directly to the third party who does that work — it is not part of
            your deposit or the balance you pay the ranch.
          </p>
        </div>
      )}

      {/* The ranch's own "what happens next" script. Blank = nothing. */}
      {steps.length > 0 && (
        <div className="max-w-md mx-auto border border-dust bg-white p-5">
          <h3 className="font-serif text-lg text-charcoal">How this works</h3>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-saddle leading-relaxed marker:text-charcoal marker:font-medium">
            {steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      )}

      <form onSubmit={reserve} className="max-w-md mx-auto space-y-3">
        <label htmlFor="broker-reserve-name" className="sr-only">Your name</label>
        <input
          id="broker-reserve-name"
          type="text"
          placeholder="Your name"
          aria-label="Your name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-4 py-3 border border-dust bg-white text-sm"
        />
        <label htmlFor="broker-reserve-email" className="sr-only">Your email</label>
        <input
          id="broker-reserve-email"
          type="email"
          required
          placeholder="Your email"
          aria-label="Your email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-4 py-3 border border-dust bg-white text-sm"
        />
        {/* Phone is OPTIONAL on this rail (the API treats it as optional; the
            ranch coordinates pickup by phone OR email) — no `required` here so
            the form contract matches the endpoint. */}
        <input
          type="tel"
          placeholder="Phone (optional)"
          aria-label="Phone (optional)"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="w-full px-4 py-3 border border-dust bg-white text-sm"
        />
        {error && <p className="text-sm text-weathered" role="alert">{error}</p>}
        <button
          type="submit"
          disabled={loading || !selected}
          className="w-full px-8 py-4 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-saddle disabled:opacity-50"
        >
          {loading
            ? 'Starting…'
            : selected
              ? `Reserve your ${selected.label.toLowerCase()} — ${usd(selected.depositCents)} deposit →`
              : 'Select a share'}
        </button>
        <p className="text-[11px] text-muted text-center">
          {BROKER_REFUND_POLICY_SHORT}. The ranch reaches out to arrange pickup or
          delivery, and you pay the balance straight to them.
        </p>
        <TermsNotice />
      </form>
    </div>
  );
}
