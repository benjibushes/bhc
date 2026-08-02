'use client';

// /support — buyer problem intake (Area A8).
//
// Small, focused form that writes into the Conversations table + fires a
// loud Telegram operator signal via POST /api/support/report. Works for
// locked-out buyers (no auth required). Other surfaces can deep-link with
// pre-filled context: /support?email=you@example.com&ref=recXXXXXXXXXXXXXX

import { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Container from '../components/Container';
import { emailFieldError, minLengthFieldError } from '@/lib/buyerFieldValidation';

const CATEGORIES = [
  { value: 'order-issue', label: 'Problem with my order' },
  { value: 'refund-request', label: 'I want a refund' },
  { value: 'rancher-unresponsive', label: 'My rancher went quiet' },
  { value: 'quality-claim', label: 'Quality issue with my beef' },
  { value: 'other', label: 'Something else' },
];

function SupportForm() {
  const searchParams = useSearchParams();

  const [form, setForm] = useState({
    email: searchParams.get('email') || '',
    category: 'order-issue',
    message: '',
    referralId: searchParams.get('ref') || '',
    website: '', // honeypot — hidden below, real users never fill it
  });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  // Per-field inline validation — set on blur, cleared on change.
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; message?: string }>({});

  const validateField = (name: 'email' | 'message', value: string) => {
    const err =
      name === 'email'
        ? emailFieldError(value)
        : minLengthFieldError(value, 10, 'Your message');
    setFieldErrors((f) => ({ ...f, [name]: err }));
    return err;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const emailErr = validateField('email', form.email);
    const messageErr = validateField('message', form.message);
    if (emailErr || messageErr) return;
    setSubmitting(true);
    setError('');

    try {
      const res = await fetch('/api/support/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email,
          category: form.category,
          message: form.message,
          referralId: form.referralId || undefined,
          website: form.website,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Something went wrong. Please try again.');
        setSubmitting(false);
        return;
      }

      setSuccess(true);
    } catch {
      setError('Something went wrong. Please try again.');
    }

    setSubmitting(false);
  };

  if (success) {
    return (
      <div className="max-w-2xl mx-auto text-center space-y-6">
        <h1 className="font-serif text-3xl">We got it.</h1>
        <p className="text-saddle text-lg">
          A real person will read your report and reply to your email within a day, usually sooner.
        </p>
        <div className="text-sm text-muted space-y-2">
          <p>
            What happens next: we pull up your order, reach out to your rancher if needed,
            and get back to you with a plan — not a form letter.
          </p>
          <p>
            Need to add anything or want a faster answer? Email us directly at{' '}
            <a href="mailto:hello@buyhalfcow.com" className="underline hover:text-charcoal transition-colors">
              hello@buyhalfcow.com
            </a>
            .
          </p>
        </div>
        <Link
          href="/"
          className="inline-block px-8 py-3 border border-saddle text-saddle text-sm tracking-wide hover:bg-saddle hover:text-bone transition-colors"
        >
          Back to BuyHalfCow
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto space-y-8">
      <div className="text-center space-y-2">
        <p className="text-xs uppercase tracking-widest text-saddle">Support</p>
        <h1 className="font-serif text-3xl md:text-4xl">Report a Problem</h1>
        <p className="text-sm text-muted">
          Something wrong with your order? Tell us here — a real person reads every report
          and replies within a day.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="support-email" className="block text-sm font-medium mb-1">
            Email Address <span className="text-weathered">*</span>
          </label>
          <input
            id="support-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={e => {
              setForm(f => ({ ...f, email: e.target.value }));
              if (fieldErrors.email) setFieldErrors(f => ({ ...f, email: '' }));
            }}
            onBlur={e => { if (e.target.value.trim()) validateField('email', e.target.value); }}
            placeholder="you@example.com"
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={fieldErrors.email ? 'support-email-error' : undefined}
            className={`w-full px-4 py-3 border bg-white text-base transition-colors ${
              fieldErrors.email ? 'border-weathered' : 'border-dust focus:border-charcoal'
            }`}
          />
          {fieldErrors.email ? (
            <p id="support-email-error" role="alert" className="text-sm text-weathered mt-1">
              {fieldErrors.email}
            </p>
          ) : (
            <p className="text-xs text-muted mt-1">
              Use the email you ordered with so we can find your order fast.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="support-category" className="block text-sm font-medium mb-1">
            What&apos;s going on? <span className="text-weathered">*</span>
          </label>
          <select
            id="support-category"
            name="category"
            value={form.category}
            onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
            className="w-full px-4 py-3 border border-dust bg-white text-base focus:border-charcoal transition-colors"
          >
            {CATEGORIES.map(c => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="support-message" className="block text-sm font-medium mb-1">
            Tell us what happened <span className="text-weathered">*</span>
          </label>
          <textarea
            id="support-message"
            name="message"
            required
            rows={5}
            maxLength={2000}
            value={form.message}
            onChange={e => {
              setForm(f => ({ ...f, message: e.target.value }));
              if (fieldErrors.message) setFieldErrors(f => ({ ...f, message: '' }));
            }}
            onBlur={e => { if (e.target.value.trim()) validateField('message', e.target.value); }}
            placeholder="The more detail the better — what happened, and when?"
            aria-invalid={fieldErrors.message ? true : undefined}
            aria-describedby={fieldErrors.message ? 'support-message-error' : undefined}
            className={`w-full px-4 py-3 border bg-white text-base transition-colors resize-y ${
              fieldErrors.message ? 'border-weathered' : 'border-dust focus:border-charcoal'
            }`}
          />
          {fieldErrors.message && (
            <p id="support-message-error" role="alert" className="text-sm text-weathered mt-1">
              {fieldErrors.message}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="support-order-id" className="block text-sm font-medium mb-1">
            Order ID <span className="text-muted">(optional)</span>
          </label>
          <input
            id="support-order-id"
            name="referralId"
            type="text"
            autoComplete="off"
            value={form.referralId}
            onChange={e => setForm(f => ({ ...f, referralId: e.target.value }))}
            placeholder="From your order emails, if handy"
            className="w-full px-4 py-3 border border-dust bg-white text-base focus:border-charcoal transition-colors"
          />
        </div>

        {/* Honeypot — hidden from real users, bots fill it */}
        <div className="hidden" aria-hidden="true">
          <label>
            Website
            <input
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={form.website}
              onChange={e => setForm(f => ({ ...f, website: e.target.value }))}
            />
          </label>
        </div>

        {error && (
          <div className="p-4 bg-weathered/10 border border-weathered text-weathered text-sm">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-4 bg-charcoal text-bone text-sm font-medium tracking-wide hover:bg-saddle transition-colors disabled:opacity-50"
        >
          {submitting ? 'Sending...' : 'Send Report'}
        </button>

        <p className="text-xs text-muted text-center">
          Prefer email? Reach us any time at{' '}
          <a href="mailto:hello@buyhalfcow.com" className="underline hover:text-charcoal transition-colors">
            hello@buyhalfcow.com
          </a>
          .
        </p>
      </form>
    </div>
  );
}

export default function SupportPage() {
  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <section className="py-16 md:py-20">
        <Container>
          <Suspense
            fallback={
              <div className="max-w-2xl mx-auto text-center">
                <p className="text-muted">Loading...</p>
              </div>
            }
          >
            <SupportForm />
          </Suspense>
        </Container>
      </section>

      <div className="border-t border-divider/10 py-10">
        <Container>
          <div className="max-w-4xl mx-auto flex justify-center text-sm text-muted">
            <Link href="/" className="hover:text-charcoal transition-colors">
              BuyHalfCow
            </Link>
          </div>
        </Container>
      </div>
    </main>
  );
}
