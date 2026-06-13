'use client';

// Wholesale buyer application form — client component.
// Single-column layout mirroring /access form patterns (44px+ tap targets,
// charcoal/30 borders, bone bg, charcoal submit). Fires wholesale_view on
// mount + wholesale_submit_success on success.

import { useEffect, useState } from 'react';
import { trackEvent, metaEventId } from '@/lib/analytics';
import { US_STATES } from '@/lib/states';

const BUSINESS_TYPES = [
  'Restaurant',
  'Butcher Shop',
  'Grocery',
  'Distributor',
  'Other',
];

const MONTHLY_VOLUMES = [
  '1-2 head',
  '3-5 head',
  '6-10 head',
  '10+ head',
];

const CUTS = [
  'Whole carcasses',
  'Primal cuts',
  'Custom processing',
  'Bulk ground',
];

const TIMELINES = [
  'Within 30 days',
  '1-3 months',
  '3-6 months',
  'Just exploring',
];

function validateEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(email);
}

export default function WholesaleForm() {
  const [businessName, setBusinessName] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [contactName, setContactName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [state, setState] = useState('');
  const [monthlyVolume, setMonthlyVolume] = useState('');
  const [cutsOfInterest, setCutsOfInterest] = useState<string[]>([]);
  const [timeline, setTimeline] = useState('');
  const [notes, setNotes] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  useEffect(() => {
    trackEvent('wholesale_view');
  }, []);

  const toggleCut = (cut: string) => {
    setCutsOfInterest((prev) =>
      prev.includes(cut) ? prev.filter((c) => c !== cut) : [...prev, cut],
    );
  };

  const emailValid = validateEmail(email);
  const isValid =
    businessName.trim().length >= 2 &&
    businessType !== '' &&
    contactName.trim().length >= 2 &&
    emailValid &&
    phone.trim().length >= 7 &&
    state !== '' &&
    monthlyVolume !== '' &&
    timeline !== '';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!isValid) {
      setError('please fill out all required fields.');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/wholesale/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName: businessName.trim(),
          businessType,
          contactName: contactName.trim(),
          email: email.trim().toLowerCase(),
          phone: phone.trim(),
          state,
          monthlyVolume,
          cutsOfInterest,
          timeline,
          notes: notes.trim(),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || 'submission failed');
      }

      setSuccessMessage(
        data?.message ||
          "We've received your application. Ben will personally reach out within 24-48 hours with verified ranchers in your state matching your volume + timeline.",
      );
      setIsSubmitted(true);
      // E-4 audit fix: server CAPI Lead at app/api/wholesale/signup/route.ts:235
      // uses event_id=recordId. Read recordId from response so client Pixel
      // pairs for Meta dedup (combined with E-1 fix that passes event_id as
      // 4th-arg eventID options object).
      const recordId = typeof data?.recordId === 'string' ? data.recordId : undefined;
      trackEvent('wholesale_submit_success', {
        state,
        businessType,
        monthlyVolume,
        ...(recordId ? { event_id: metaEventId(recordId) } : {}),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'something went wrong';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSubmitted) {
    return (
      <div className="max-w-2xl mx-auto text-center space-y-6 py-8">
        <h2 className="font-serif text-3xl sm:text-4xl text-charcoal lowercase">
          you&apos;re in
        </h2>
        <p className="text-saddle text-base sm:text-lg leading-relaxed">
          {successMessage}
        </p>
        <div className="pt-4">
          <a
            href="/start"
            className="text-saddle hover:text-charcoal underline underline-offset-2 transition-colors"
          >
            &larr; back to /start
          </a>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 max-w-xl">
      {/* 1. Business name */}
      <div>
        <label htmlFor="businessName" className="block text-sm text-charcoal mb-1">
          business name <span className="text-saddle">*</span>
        </label>
        <input
          id="businessName"
          type="text"
          required
          autoComplete="organization"
          className="w-full border border-charcoal/30 px-4 py-3 min-h-[44px] bg-bone text-charcoal focus:outline-none focus:border-charcoal"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
        />
      </div>

      {/* 2. Business type */}
      <div>
        <label htmlFor="businessType" className="block text-sm text-charcoal mb-1">
          business type <span className="text-saddle">*</span>
        </label>
        <select
          id="businessType"
          required
          className="w-full border border-charcoal/30 px-4 py-3 min-h-[44px] bg-bone text-charcoal focus:outline-none focus:border-charcoal appearance-none"
          value={businessType}
          onChange={(e) => setBusinessType(e.target.value)}
        >
          <option value="">pick one</option>
          {BUSINESS_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {/* 3. Contact name */}
      <div>
        <label htmlFor="contactName" className="block text-sm text-charcoal mb-1">
          contact name <span className="text-saddle">*</span>
        </label>
        <input
          id="contactName"
          type="text"
          required
          autoComplete="name"
          className="w-full border border-charcoal/30 px-4 py-3 min-h-[44px] bg-bone text-charcoal focus:outline-none focus:border-charcoal"
          value={contactName}
          onChange={(e) => setContactName(e.target.value)}
        />
      </div>

      {/* 4. Email */}
      <div>
        <label htmlFor="email" className="block text-sm text-charcoal mb-1">
          email <span className="text-saddle">*</span>
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          className="w-full border border-charcoal/30 px-4 py-3 min-h-[44px] bg-bone text-charcoal focus:outline-none focus:border-charcoal"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      {/* 5. Phone */}
      <div>
        <label htmlFor="phone" className="block text-sm text-charcoal mb-1">
          phone <span className="text-saddle">*</span>
        </label>
        <input
          id="phone"
          type="tel"
          required
          autoComplete="tel"
          className="w-full border border-charcoal/30 px-4 py-3 min-h-[44px] bg-bone text-charcoal focus:outline-none focus:border-charcoal"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </div>

      {/* 6. State */}
      <div>
        <label htmlFor="state" className="block text-sm text-charcoal mb-1">
          state <span className="text-saddle">*</span>
        </label>
        <select
          id="state"
          required
          className="w-full border border-charcoal/30 px-4 py-3 min-h-[44px] bg-bone text-charcoal focus:outline-none focus:border-charcoal appearance-none"
          value={state}
          onChange={(e) => setState(e.target.value)}
        >
          <option value="">pick your state</option>
          {US_STATES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {/* 7. Monthly volume */}
      <div>
        <label htmlFor="monthlyVolume" className="block text-sm text-charcoal mb-1">
          monthly volume estimate <span className="text-saddle">*</span>
        </label>
        <select
          id="monthlyVolume"
          required
          className="w-full border border-charcoal/30 px-4 py-3 min-h-[44px] bg-bone text-charcoal focus:outline-none focus:border-charcoal appearance-none"
          value={monthlyVolume}
          onChange={(e) => setMonthlyVolume(e.target.value)}
        >
          <option value="">how much beef per month?</option>
          {MONTHLY_VOLUMES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>

      {/* 8. Cuts of interest (multi-select) */}
      <div>
        <span className="block text-sm text-charcoal mb-2">
          cuts of interest <span className="text-saddle">(pick any)</span>
        </span>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {CUTS.map((cut) => {
            const selected = cutsOfInterest.includes(cut);
            return (
              <button
                key={cut}
                type="button"
                onClick={() => toggleCut(cut)}
                aria-pressed={selected}
                className={`text-left px-4 py-3 min-h-[44px] border text-sm transition-colors ${
                  selected
                    ? 'border-charcoal bg-bone-warm text-charcoal'
                    : 'border-charcoal/30 bg-bone text-saddle hover:border-charcoal'
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  <span
                    className={`inline-block w-4 h-4 border ${
                      selected ? 'bg-charcoal border-charcoal' : 'border-charcoal/40'
                    }`}
                    aria-hidden="true"
                  />
                  {cut}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 9. Timeline */}
      <div>
        <label htmlFor="timeline" className="block text-sm text-charcoal mb-1">
          timeline <span className="text-saddle">*</span>
        </label>
        <select
          id="timeline"
          required
          className="w-full border border-charcoal/30 px-4 py-3 min-h-[44px] bg-bone text-charcoal focus:outline-none focus:border-charcoal appearance-none"
          value={timeline}
          onChange={(e) => setTimeline(e.target.value)}
        >
          <option value="">when do you want supply?</option>
          {TIMELINES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {/* 10. Notes */}
      <div>
        <label htmlFor="notes" className="block text-sm text-charcoal mb-1">
          notes <span className="text-saddle">(optional)</span>
        </label>
        <textarea
          id="notes"
          rows={4}
          maxLength={500}
          className="w-full border border-charcoal/30 px-4 py-3 bg-bone text-charcoal focus:outline-none focus:border-charcoal resize-none"
          value={notes}
          onChange={(e) => setNotes(e.target.value.slice(0, 500))}
          placeholder="anything specific — sourcing preferences, processing requirements, etc."
        />
        <p className="text-xs text-saddle mt-1 text-right">{notes.length} / 500</p>
      </div>

      {error && (
        <div className="p-4 border border-weathered bg-transparent text-weathered text-sm">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={!isValid || isSubmitting}
        className="w-full bg-charcoal text-bone font-semibold uppercase tracking-wider text-sm py-4 min-h-[52px] hover:bg-charcoal/80 disabled:opacity-40 transition-opacity"
      >
        {isSubmitting ? 'submitting…' : 'apply for wholesale access'}
      </button>

      <p className="text-xs text-saddle text-center">
        no spam. ben reaches out personally within 24-48 hours.
      </p>
    </form>
  );
}
