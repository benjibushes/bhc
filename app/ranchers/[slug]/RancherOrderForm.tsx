'use client';

import { useState, useEffect } from 'react';
import { track } from '@/lib/track';

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY',
];

const TIER_LABEL: Record<string, string> = {
  quarter: 'Quarter Cow',
  half: 'Half Cow',
  whole: 'Whole Cow',
};

interface TierData {
  price: number;
  lbs: string;
}

interface MemberSession {
  id: string;
  name?: string;
  email?: string;
  state?: string;
}

// ── Commerce mode (Supabase catalog) ─────────────────────────────────────────
// Plain serializable shapes the SERVER COMPONENT resolves from
// lib/commerce/repository (getRancherCatalog) and passes down. Money already in
// CENTS from the ETL; we only DISPLAY (round to dollars) here — never recompute
// deposits. `available`: null = unlimited stock, a number = units left (0 = sold
// out). When the `commerce` prop is present the form renders the live Supabase
// catalog + on-platform checkout button; when absent it falls back to the legacy
// Airtable lead-request path below (unchanged).
export interface CommerceVariant {
  variantId: string;
  label: string;
  priceCents: number;
  depositCents: number;
  weightLbs: number | null;
  available: number | null;
}

export interface CommerceProduct {
  productId: string;
  type: 'cow_share' | 'custom' | 'csa';
  name: string;
  description: string | null;
  variants: CommerceVariant[];
}

export interface CommerceCatalog {
  rancherSlug: string;
  cowShareVariants: CommerceVariant[];
  customProducts: CommerceProduct[];
}

interface Props {
  slug: string;
  rancherName: string;
  ranchName: string;
  quarter?: TierData;
  half?: TierData;
  whole?: TierData;
  /**
   * When present, render the live Supabase commerce catalog + on-platform
   * checkout (POST /api/commerce/cart → Stripe). When undefined, render the
   * legacy Airtable lead-request flow. The server component decides which by
   * whether getRancherCatalog() returned products.
   */
  commerce?: CommerceCatalog;
}

const dollars = (cents: number) => Math.round(cents / 100).toLocaleString();
// Surface unit counts only when stock is genuinely scarce — a "3 left" nudge,
// not a live inventory readout. null/unlimited → never shown.
const LOW_STOCK_THRESHOLD = 10;

/**
 * Inline order interaction for a rancher page. TWO modes:
 *
 *  1. COMMERCE (commerce prop set) — the rancher has a live Supabase catalog.
 *     Buyer picks a share/product variant, qty defaults to 1, and the buy button
 *     POSTs { rancherSlug, items:[{ variantId, qty }] } to /api/commerce/cart,
 *     then redirects the browser to the returned Stripe checkoutUrl. Sold-out
 *     variants are disabled; a soldOut/error response surfaces inline.
 *
 *  2. LEGACY (commerce prop absent) — unchanged. Buyer submits an order request
 *     → BHC creates a Referral + emails rancher (reply-to=buyer). Used for every
 *     rancher WITHOUT a live commerce catalog (legacy / unconnected).
 */
export default function RancherOrderForm({
  slug,
  rancherName,
  ranchName,
  quarter,
  half,
  whole,
  commerce,
}: Props) {
  if (commerce) {
    return (
      <CommerceCatalogForm
        rancherName={rancherName}
        ranchName={ranchName}
        commerce={commerce}
      />
    );
  }
  return (
    <LegacyOrderForm
      slug={slug}
      rancherName={rancherName}
      ranchName={ranchName}
      quarter={quarter}
      half={half}
      whole={whole}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMERCE MODE — live Supabase catalog + on-platform Stripe checkout.
// ─────────────────────────────────────────────────────────────────────────────

function CommerceCatalogForm({
  rancherName,
  ranchName,
  commerce,
}: {
  rancherName: string;
  ranchName: string;
  commerce: CommerceCatalog;
}) {
  // variantId currently being checked out (drives the per-button spinner) +
  // an inline error keyed to the variant that failed.
  const [pendingVariant, setPendingVariant] = useState<string | null>(null);
  const [errorFor, setErrorFor] = useState<{ variantId: string; message: string } | null>(null);

  async function buy(variant: CommerceVariant) {
    if (variant.available === 0) return; // sold out — button is disabled anyway
    setErrorFor(null);
    setPendingVariant(variant.variantId);

    track('InitiateCheckout', {
      content_name: rancherName,
      content_category: variant.label,
      ranchSlug: commerce.rancherSlug,
      value: Math.round(variant.priceCents / 100),
      currency: 'USD',
    });

    try {
      const res = await fetch('/api/commerce/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rancherSlug: commerce.rancherSlug,
          items: [{ variantId: variant.variantId, qty: 1 }],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.checkoutUrl) {
        setErrorFor({
          variantId: variant.variantId,
          message: data?.soldOut
            ? 'Just sold out — refresh to see what’s still available.'
            : data?.error || 'Could not start checkout — try again.',
        });
        setPendingVariant(null);
        return;
      }
      // Hand the browser to Stripe-hosted checkout.
      window.location.assign(data.checkoutUrl as string);
    } catch {
      setErrorFor({ variantId: variant.variantId, message: 'Network error — try again.' });
      setPendingVariant(null);
    }
  }

  const hasCowShares = commerce.cowShareVariants.length > 0;
  const hasCustom = commerce.customProducts.length > 0;

  return (
    <div className="space-y-10">
      {/* Cow-share variants — Whole → Half → Quarter (largest anchors first),
          ordered server-side. */}
      {hasCowShares && (
        <div className="grid md:grid-cols-3 gap-4">
          {commerce.cowShareVariants.map((v, i) => (
            <CommerceVariantCard
              key={v.variantId}
              variant={v}
              // Mid card (Half, when three shares present) reads as the anchor.
              highlighted={commerce.cowShareVariants.length === 3 ? i === 1 : false}
              pending={pendingVariant === v.variantId}
              disabledByOther={pendingVariant !== null && pendingVariant !== v.variantId}
              error={errorFor?.variantId === v.variantId ? errorFor.message : null}
              onBuy={() => buy(v)}
            />
          ))}
        </div>
      )}

      {/* Custom products (each with its own variant rows). */}
      {hasCustom && (
        <div className="space-y-6">
          {hasCowShares && (
            <p className="text-center text-xs uppercase tracking-widest text-saddle">
              More from {ranchName}
            </p>
          )}
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {commerce.customProducts.flatMap((product) =>
              product.variants.map((v) => (
                <CommerceVariantCard
                  key={v.variantId}
                  variant={v}
                  productName={product.name}
                  productDescription={product.description}
                  highlighted={false}
                  pending={pendingVariant === v.variantId}
                  disabledByOther={pendingVariant !== null && pendingVariant !== v.variantId}
                  error={errorFor?.variantId === v.variantId ? errorFor.message : null}
                  onBuy={() => buy(v)}
                />
              )),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CommerceVariantCard({
  variant,
  productName,
  productDescription,
  highlighted,
  pending,
  disabledByOther,
  error,
  onBuy,
}: {
  variant: CommerceVariant;
  productName?: string;
  productDescription?: string | null;
  highlighted: boolean;
  pending: boolean;
  disabledByOther: boolean;
  error: string | null;
  onBuy: () => void;
}) {
  const soldOut = variant.available === 0;
  const lowStock =
    variant.available !== null && variant.available > 0 && variant.available <= LOW_STOCK_THRESHOLD;
  const heading = productName ? `${productName} — ${variant.label}` : variant.label;

  return (
    <div
      className={`flex flex-col p-6 border ${
        soldOut
          ? 'border-dust bg-bone-warm text-charcoal/60'
          : highlighted
            ? 'border-saddle bg-saddle text-bone'
            : 'border-dust bg-white text-charcoal'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <p
          className={`text-xs uppercase tracking-widest ${
            highlighted && !soldOut ? 'text-bone/70' : 'text-dust'
          }`}
        >
          {heading}
        </p>
        {soldOut && (
          <span className="text-[10px] uppercase tracking-widest text-weathered font-medium">
            Sold out
          </span>
        )}
        {!soldOut && lowStock && (
          <span
            className={`text-[10px] uppercase tracking-widest font-medium ${
              highlighted ? 'text-bone/80' : 'text-saddle'
            }`}
          >
            {variant.available} left
          </span>
        )}
      </div>

      <p className="font-serif text-4xl font-bold mb-1">${dollars(variant.priceCents)}</p>

      {variant.weightLbs ? (
        <p className={`text-sm ${highlighted && !soldOut ? 'text-bone/80' : 'text-dust'}`}>
          {variant.weightLbs} lbs of beef
        </p>
      ) : null}

      {productDescription ? (
        <p className={`text-sm mt-2 leading-relaxed ${highlighted && !soldOut ? 'text-bone/85' : 'text-charcoal/75'}`}>
          {productDescription}
        </p>
      ) : null}

      {/* Reserve framing — round-dollar deposit, "Reserve your share" voice.
          Never shown when sold out. */}
      {!soldOut && (
        <p className={`text-xs mt-3 ${highlighted ? 'text-bone/80' : 'text-saddle'}`}>
          Reserve from ${dollars(variant.depositCents)} today
        </p>
      )}

      <div className="mt-6">
        {error && <p className="text-sm text-weathered mb-3">{error}</p>}
        <button
          type="button"
          onClick={onBuy}
          disabled={soldOut || pending || disabledByOther}
          className={`block w-full text-center py-3 text-sm font-medium tracking-wide uppercase transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            soldOut
              ? 'bg-dust text-bone'
              : highlighted
                ? 'bg-bone text-saddle hover:bg-white'
                : 'bg-charcoal text-bone hover:bg-saddle'
          }`}
        >
          {soldOut ? 'Sold out' : pending ? 'Starting checkout…' : 'Reserve your share →'}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY MODE — unchanged Airtable lead-request flow (ranchers WITHOUT a live
// commerce catalog). Submits an order REQUEST through BHC (no payment now);
// rancher reaches back out within 48h.
// ─────────────────────────────────────────────────────────────────────────────

function LegacyOrderForm({
  slug,
  rancherName,
  ranchName,
  quarter,
  half,
  whole,
}: {
  slug: string;
  rancherName: string;
  ranchName: string;
  quarter?: TierData;
  half?: TierData;
  whole?: TierData;
}) {
  const [selectedTier, setSelectedTier] = useState<'quarter' | 'half' | 'whole' | null>(null);
  const [session, setSession] = useState<MemberSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    phone: '',
    state: '',
    zip: '',
    message: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<{ rancherName: string; expectedHours: number } | null>(null);

  // Probe member session — if logged in, skip name/email
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/member/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.authenticated && data.member) {
          setSession({
            id: data.member.id,
            name: data.member.name,
            email: data.member.email,
            state: data.member.state,
          });
          setForm((f) => ({
            ...f,
            fullName: data.member.name || '',
            email: data.member.email || '',
            state: data.member.state || '',
          }));
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSessionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleTierClick(tier: 'quarter' | 'half' | 'whole') {
    const tierData = tier === 'quarter' ? quarter : tier === 'half' ? half : whole;
    track('ViewContent', {
      content_name: rancherName,
      content_category: TIER_LABEL[tier],
      ranchSlug: slug,
      value: tierData?.price || 0,
      currency: 'USD',
    });
    setSelectedTier(tier);
    setError('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedTier) return;
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/orders/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          tier: selectedTier,
          fullName: form.fullName,
          email: form.email,
          phone: form.phone,
          state: form.state,
          zip: form.zip,
          message: form.message,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || 'Something went wrong — try again.');
        setLoading(false);
        return;
      }
      const tierData =
        selectedTier === 'quarter' ? quarter : selectedTier === 'half' ? half : whole;
      track('Lead', {
        content_name: rancherName,
        ranchSlug: slug,
        orderType: TIER_LABEL[selectedTier],
        state: form.state,
        value: tierData?.price || 0,
        currency: 'USD',
      });
      setSuccess({
        rancherName: data.rancherName || rancherName,
        expectedHours: data.expectedResponseHours || 48,
      });
    } catch {
      setError('Network error — try again.');
    }
    setLoading(false);
  }

  const tierLabel = selectedTier
    ? selectedTier.charAt(0).toUpperCase() + selectedTier.slice(1)
    : '';

  return (
    <>
      {/* Pricing cards — ordered Whole → Half → Quarter so the largest share
          anchors the buyer first (price anchoring). Half stays visually
          highlighted as the recommended middle. Presentational order only;
          selection logic, values, and labels are unchanged. */}
      <div className="grid md:grid-cols-3 gap-4">
        {whole && (
          <PricingCard
            label="Whole"
            lbs={whole.lbs}
            price={whole.price}
            highlighted={false}
            onClick={() => handleTierClick('whole')}
          />
        )}
        {half && (
          <PricingCard
            label="Half"
            lbs={half.lbs}
            price={half.price}
            highlighted
            onClick={() => handleTierClick('half')}
          />
        )}
        {quarter && (
          <PricingCard
            label="Quarter"
            lbs={quarter.lbs}
            price={quarter.price}
            highlighted={false}
            onClick={() => handleTierClick('quarter')}
          />
        )}
      </div>

      {/* Modal */}
      {selectedTier && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-bone max-w-md w-full p-8 space-y-6 max-h-[90vh] overflow-y-auto">
            {success ? (
              <div className="space-y-4">
                <p className="text-xs uppercase tracking-widest text-saddle">
                  Order request sent
                </p>
                <h2 className="font-serif text-2xl">
                  You&rsquo;re connected with {success.rancherName}.
                </h2>
                <p className="text-sm text-charcoal leading-relaxed">
                  We just emailed {success.rancherName} your <strong>{tierLabel}</strong>{' '}
                  request. They typically reply within {success.expectedHours} hours to
                  confirm timing, processing date, and payment details.
                </p>
                <p className="text-sm text-saddle">
                  Check your inbox — confirmation is on its way. Replies from{' '}
                  {success.rancherName} land directly with you.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedTier(null);
                    setSuccess(null);
                    setForm({
                      fullName: session?.name || '',
                      email: session?.email || '',
                      phone: '',
                      state: session?.state || '',
                      zip: '',
                      message: '',
                    });
                  }}
                  className="w-full py-3 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase hover:bg-saddle transition-colors"
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                <div>
                  <p className="text-xs uppercase tracking-widest text-saddle mb-2">
                    {ranchName} — {tierLabel} Share
                  </p>
                  <h2 className="font-serif text-2xl">
                    {session ? 'Send your order request' : 'Connect with the rancher'}
                  </h2>
                  <p className="text-sm text-saddle mt-1">
                    {session
                      ? `${rancherName} will reach out within 48h to confirm details.`
                      : `Drop your details and ${rancherName} will reach back out within 48h.`}
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  {!session && (
                    <>
                      <input
                        type="text"
                        placeholder="Full Name"
                        required
                        value={form.fullName}
                        onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
                        className="w-full px-4 py-3 border border-dust bg-white text-sm"
                      />
                      <input
                        type="email"
                        placeholder="Email"
                        required
                        value={form.email}
                        onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                        className="w-full px-4 py-3 border border-dust bg-white text-sm"
                      />
                      <input
                        type="tel"
                        placeholder="Phone (optional)"
                        value={form.phone}
                        onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                        className="w-full px-4 py-3 border border-dust bg-white text-sm"
                      />
                      <div className="grid grid-cols-2 gap-3">
                        <select
                          value={form.state}
                          onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
                          className="w-full px-4 py-3 border border-dust bg-white text-sm"
                        >
                          <option value="">State (optional)</option>
                          {US_STATES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          placeholder="ZIP (optional)"
                          inputMode="numeric"
                          pattern="\d{5}"
                          maxLength={5}
                          value={form.zip}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, zip: e.target.value.replace(/\D/g, '').slice(0, 5) }))
                          }
                          className="w-full px-4 py-3 border border-dust bg-white text-sm"
                        />
                      </div>
                    </>
                  )}

                  {session && (
                    <div className="bg-white p-3 border border-dust text-sm">
                      <p className="text-saddle text-xs uppercase tracking-widest mb-1">
                        Sending as
                      </p>
                      <p className="font-medium">{session.name || session.email}</p>
                      <p className="text-saddle">{session.email}</p>
                    </div>
                  )}

                  <textarea
                    placeholder={
                      session
                        ? 'Anything you want them to know? (optional)'
                        : 'Anything to mention? Timing, custom cuts, questions… (optional)'
                    }
                    value={form.message}
                    onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
                    rows={3}
                    className="w-full px-4 py-3 border border-dust bg-white text-sm resize-none"
                  />

                  {error && (
                    <p className="text-sm text-weathered">{error}</p>
                  )}

                  <button
                    type="submit"
                    disabled={loading || sessionLoading}
                    className="w-full py-4 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase hover:bg-saddle transition-colors disabled:opacity-50"
                  >
                    {loading ? 'Sending…' : `Send order request →`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedTier(null)}
                    className="w-full text-center text-xs text-dust hover:text-charcoal"
                  >
                    Cancel
                  </button>
                  <p className="text-[10px] text-dust text-center leading-relaxed">
                    No payment now. {rancherName} confirms timing + arranges payment directly.
                  </p>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function PricingCard({
  label,
  lbs,
  price,
  highlighted,
  onClick,
}: {
  label: string;
  lbs: string;
  price: number;
  highlighted: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={`flex flex-col p-6 border ${
        highlighted
          ? 'border-saddle bg-saddle text-bone'
          : 'border-dust bg-white text-charcoal'
      }`}
    >
      <p
        className={`text-xs uppercase tracking-widest mb-3 ${
          highlighted ? 'text-bone/70' : 'text-dust'
        }`}
      >
        {label}
      </p>
      <p className="font-serif text-4xl font-bold mb-1">
        ${price.toLocaleString()}
      </p>
      {lbs && (
        <p className={`text-sm mb-6 ${highlighted ? 'text-bone/80' : 'text-dust'}`}>
          {lbs} of beef
        </p>
      )}
      <div className="mt-auto">
        <button
          onClick={onClick}
          className={`block w-full text-center py-3 text-sm font-medium tracking-wide transition-colors ${
            highlighted
              ? 'bg-bone text-saddle hover:bg-white'
              : 'bg-charcoal text-bone hover:bg-saddle'
          }`}
        >
          Request {label} →
        </button>
      </div>
    </div>
  );
}
