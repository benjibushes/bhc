'use client';

import { useState, useEffect } from 'react';
import { track } from '@/lib/track';
import { accessFallbackUrl } from '@/lib/accessFallbackUrl';
import { formatPhoneInput, isValidUsPhone } from '@/lib/phoneFormat';
import SmsConsentCheckbox, { TermsNotice } from '@/app/components/SmsConsentCheckbox';
import {
  emailFieldError,
  phoneFieldError,
  requiredFieldError,
} from '@/lib/buyerFieldValidation';

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
  /**
   * True when this rancher has `Service ZIP Prefixes` — i.e. Ben signed an
   * exclusivity contract for a specific service area, so the ZIP decides
   * whether this buyer may be served at all. Makes ZIP REQUIRED (and shows it
   * to logged-in buyers, who otherwise never see the address fields). False
   * for every rancher today — the form is byte-identical to before.
   */
  requireZip?: boolean;
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
  requireZip = false,
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
    // honeypot — bots fill, humans don't see (server fakes success when set)
    website: '',
  });
  // TCPA SMS consent — UNCHECKED by default, never gates the request. Only
  // shown with the guest fields (phone is only collected when logged out).
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<{ rancherName: string; expectedHours: number } | null>(null);
  // Per-field inline validation — set on blur, cleared on change, rendered
  // directly under the offending field (the single bottom error line used to
  // be the only feedback).
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const zipError = (v: string) =>
    requireZip && !/^\d{5}$/.test(v.trim()) ? 'Enter your 5-digit ZIP code.' : '';

  const validateField = (name: 'fullName' | 'email' | 'phone' | 'zip', value: string) => {
    const err =
      name === 'fullName'
        ? requiredFieldError(value, 'Your name')
        : name === 'email'
          ? emailFieldError(value)
          : name === 'phone'
            ? phoneFieldError(value)
            : zipError(value);
    setFieldErrors((f) => ({ ...f, [name]: err }));
    return err;
  };

  const clearFieldError = (name: string) => {
    setFieldErrors((f) => (f[name] ? { ...f, [name]: '' } : f));
  };

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

  // H3 (2026-07-28): the modal had no backdrop-tap close and no Escape — the
  // only exits were the tiny Cancel text link or Done. Success state closes
  // like Done (full reset); form state closes like Cancel (keeps typed input
  // for a re-open). Never closes mid-submit — a mis-tap during the POST would
  // hide the confirmation the buyer is about to get.
  function closeModal() {
    if (loading) return;
    if (success) {
      setSuccess(null);
      setForm({
        fullName: session?.name || '',
        email: session?.email || '',
        phone: '',
        state: session?.state || '',
        zip: '',
        message: '',
        website: '',
      });
      setSmsOptIn(false);
    }
    setSelectedTier(null);
  }

  // Escape closes while the modal is open (standard dialog affordance; the
  // backdrop click handler below is its pointer twin).
  useEffect(() => {
    if (!selectedTier) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTier, success, loading, session]);

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
    // H1 (2026-07-28): phone is REQUIRED on the guest form (the success screen
    // promises a 48h callback; phone is the rescue channel when rancher email
    // goes quiet). isValidUsPhone strips a leading +1 before counting digits —
    // same shared guard as every other signup door. Logged-in members never
    // see the phone field; the API tolerates their record's existing contact.
    if (!session) {
      const errs = [
        validateField('fullName', form.fullName),
        validateField('email', form.email),
        validateField('phone', form.phone),
        validateField('zip', form.zip),
      ];
      if (errs.some(Boolean)) return;
    } else if (requireZip && validateField('zip', form.zip)) {
      return;
    }
    if (!session && !isValidUsPhone(form.phone)) {
      setError(`Please enter a valid phone number so ${rancherName} can reach you.`);
      return;
    }
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
          website: form.website,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // `fallbackToMatch` = this ranch can't serve them (paused, or contracted
        // to a service area that doesn't cover their ZIP). Hand them to the
        // quiz, which matches them to a ranch that can — never a dead end.
        // K1 (2026-07-28): carry ?error= so /access shows an honest banner
        // instead of a pristine quiz that looks like the form silently reset.
        // No rancher re-pin — this ranch just declined them.
        if (data?.fallbackToMatch) {
          window.location.href = accessFallbackUrl('reserve_fallback');
          return;
        }
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

      {/* Modal — backdrop tap + Escape close (H3). The click guard checks
          e.target === e.currentTarget so clicks INSIDE the panel never close;
          keyboard users keep normal tab flow inside the panel. */}
      {selectedTier && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`${ranchName} — ${tierLabel} share order request`}
            className="bg-bone max-w-md w-full p-8 space-y-6 max-h-[90vh] overflow-y-auto"
          >
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
                  onClick={closeModal}
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
                  {/* Honeypot — hidden field, real users don't see it */}
                  <input
                    type="text"
                    name="website"
                    value={form.website}
                    onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
                    tabIndex={-1}
                    autoComplete="off"
                    style={{ position: 'absolute', left: '-9999px', width: '1px', height: '1px' }}
                    aria-hidden="true"
                  />
                  {!session && (
                    <>
                      <input
                        type="text"
                        placeholder="Full Name"
                        aria-label="Full name"
                        required
                        autoComplete="name"
                        value={form.fullName}
                        onChange={(e) => {
                          setForm((f) => ({ ...f, fullName: e.target.value }));
                          clearFieldError('fullName');
                        }}
                        onBlur={(e) => { if (e.target.value.trim()) validateField('fullName', e.target.value); }}
                        aria-invalid={fieldErrors.fullName ? true : undefined}
                        aria-describedby={fieldErrors.fullName ? 'order-fullname-error' : undefined}
                        className={`w-full px-4 py-3 border bg-white text-base ${fieldErrors.fullName ? 'border-weathered' : 'border-dust'}`}
                      />
                      {fieldErrors.fullName && (
                        <p id="order-fullname-error" role="alert" className="text-sm text-weathered -mt-2">
                          {fieldErrors.fullName}
                        </p>
                      )}
                      <input
                        type="email"
                        placeholder="Email"
                        aria-label="Email"
                        required
                        autoComplete="email"
                        inputMode="email"
                        value={form.email}
                        onChange={(e) => {
                          setForm((f) => ({ ...f, email: e.target.value }));
                          clearFieldError('email');
                        }}
                        onBlur={(e) => { if (e.target.value.trim()) validateField('email', e.target.value); }}
                        aria-invalid={fieldErrors.email ? true : undefined}
                        aria-describedby={fieldErrors.email ? 'order-email-error' : undefined}
                        className={`w-full px-4 py-3 border bg-white text-base ${fieldErrors.email ? 'border-weathered' : 'border-dust'}`}
                      />
                      {fieldErrors.email && (
                        <p id="order-email-error" role="alert" className="text-sm text-weathered -mt-2">
                          {fieldErrors.email}
                        </p>
                      )}
                      {/* H1 (2026-07-28): REQUIRED. The success screen promises
                          a 48h callback and phone is the rescue channel when
                          rancher email goes quiet — "(optional)" was a promise
                          we couldn't keep. Formatting/validation shared with
                          every other door via lib/phoneFormat (never fork). */}
                      <input
                        type="tel"
                        placeholder="Phone"
                        aria-label="Phone"
                        required
                        autoComplete="tel"
                        inputMode="tel"
                        value={form.phone}
                        onChange={(e) => {
                          setForm((f) => ({ ...f, phone: formatPhoneInput(e.target.value) }));
                          clearFieldError('phone');
                        }}
                        onBlur={(e) => { if (e.target.value.trim()) validateField('phone', e.target.value); }}
                        aria-invalid={fieldErrors.phone ? true : undefined}
                        aria-describedby={fieldErrors.phone ? 'order-phone-error' : undefined}
                        className={`w-full px-4 py-3 border bg-white text-base ${fieldErrors.phone ? 'border-weathered' : 'border-dust'}`}
                      />
                      {fieldErrors.phone && (
                        <p id="order-phone-error" role="alert" className="text-sm text-weathered -mt-2">
                          {fieldErrors.phone}
                        </p>
                      )}
                      <div className="grid grid-cols-2 gap-3">
                        <select
                          aria-label="State (optional)"
                          autoComplete="address-level1"
                          value={form.state}
                          onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
                          className="w-full px-4 py-3 border border-dust bg-white text-base"
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
                          placeholder={requireZip ? 'ZIP' : 'ZIP (optional)'}
                          aria-label={requireZip ? 'ZIP code' : 'ZIP code (optional)'}
                          required={requireZip}
                          inputMode="numeric"
                          autoComplete="postal-code"
                          pattern="\d{5}"
                          maxLength={5}
                          value={form.zip}
                          onChange={(e) => {
                            setForm((f) => ({ ...f, zip: e.target.value.replace(/\D/g, '').slice(0, 5) }));
                            clearFieldError('zip');
                          }}
                          onBlur={(e) => { if (e.target.value.trim()) validateField('zip', e.target.value); }}
                          aria-invalid={fieldErrors.zip ? true : undefined}
                          aria-describedby={fieldErrors.zip ? 'order-zip-error' : undefined}
                          className={`w-full px-4 py-3 border bg-white text-base ${fieldErrors.zip ? 'border-weathered' : 'border-dust'}`}
                        />
                      </div>
                      {fieldErrors.zip && (
                        <p id="order-zip-error" role="alert" className="text-sm text-weathered -mt-2">
                          {fieldErrors.zip}
                        </p>
                      )}
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

                  {/* Logged-in buyers skip the address fields entirely, so a
                      ZIP-gated ranch would otherwise have no way to learn where
                      they are and would (correctly) refuse every request. Ask
                      here, only in that case. */}
                  {session && requireZip && (
                    <>
                      <input
                        type="text"
                        placeholder="Delivery ZIP"
                        aria-label="Delivery ZIP code"
                        required
                        inputMode="numeric"
                        autoComplete="postal-code"
                        pattern="\d{5}"
                        maxLength={5}
                        value={form.zip}
                        onChange={(e) => {
                          setForm((f) => ({ ...f, zip: e.target.value.replace(/\D/g, '').slice(0, 5) }));
                          clearFieldError('zip');
                        }}
                        onBlur={(e) => { if (e.target.value.trim()) validateField('zip', e.target.value); }}
                        aria-invalid={fieldErrors.zip ? true : undefined}
                        aria-describedby={fieldErrors.zip ? 'order-zip-error' : undefined}
                        className={`w-full px-4 py-3 border bg-white text-base ${fieldErrors.zip ? 'border-weathered' : 'border-dust'}`}
                      />
                      {fieldErrors.zip && (
                        <p id="order-zip-error" role="alert" className="text-sm text-weathered -mt-2">
                          {fieldErrors.zip}
                        </p>
                      )}
                    </>
                  )}

                  <textarea
                    placeholder={
                      session
                        ? 'Anything you want them to know? (optional)'
                        : 'Anything to mention? Timing, custom cuts, questions… (optional)'
                    }
                    aria-label="Message (optional)"
                    value={form.message}
                    onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
                    rows={3}
                    className="w-full px-4 py-3 border border-dust bg-white text-base resize-none"
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
                    className="w-full text-center text-xs text-muted hover:text-charcoal"
                  >
                    Cancel
                  </button>
                  <p className="text-[10px] text-muted text-center leading-relaxed">
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
          highlighted ? 'text-bone/70' : 'text-muted'
        }`}
      >
        {label}
      </p>
      <p className="font-serif text-4xl font-bold mb-1">
        ${price.toLocaleString()}
      </p>
      {lbs && (
        <p className={`text-sm mb-6 ${highlighted ? 'text-bone/80' : 'text-muted'}`}>
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
