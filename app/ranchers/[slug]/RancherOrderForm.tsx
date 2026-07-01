'use client';

import { useState, useEffect } from 'react';
import { track } from '@/lib/track';
import SmsConsentCheckbox, { TermsNotice } from '@/app/components/SmsConsentCheckbox';

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

interface Props {
  slug: string;
  rancherName: string;
  ranchName: string;
  quarter?: TierData;
  half?: TierData;
  whole?: TierData;
}

/**
 * Inline order request form. Replaces the old "redirect to rancher's external
 * payment link" flow. Buyer submits an order request → BHC creates a Referral
 * + emails rancher (reply-to=buyer) + emails buyer confirmation. Rancher
 * reaches back out within 48h to confirm timing + payment.
 *
 * If buyer is logged into a member session, name/email skip — just pick tier
 * + add optional message. If not, full form (name, email, phone, state, ZIP).
 */
export default function RancherOrderForm({
  slug,
  rancherName,
  ranchName,
  quarter,
  half,
  whole,
}: Props) {
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
  // TCPA SMS consent — UNCHECKED by default, never gates the request. Only
  // shown with the guest fields (phone is only collected when logged out).
  const [smsOptIn, setSmsOptIn] = useState(false);
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
          // Funnel payload convention → Consumers `SMS Opt-In` server-side.
          smsOptIn,
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
                    setSmsOptIn(false);
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
                      <SmsConsentCheckbox checked={smsOptIn} onChange={setSmsOptIn} />
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
                  <TermsNotice />
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
