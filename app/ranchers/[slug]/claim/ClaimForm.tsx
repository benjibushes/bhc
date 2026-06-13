'use client';

import { useState } from 'react';

// Client form for the prospect claim page. Submits to /api/prospects/claim;
// on success shows a confirmation panel telling the operator to check their
// email. The actual magic-link click flow goes through GET on the same API
// route (server-side redirect to the confirmed=1 page).
export default function ClaimForm({
  slug,
  ranchName,
}: {
  slug: string;
  ranchName: string;
}) {
  const [operatorName, setOperatorName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ manualReview: boolean; sentTo: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/prospects/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, operatorName, email, phone }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Something went wrong. Try again.');
        setSubmitting(false);
        return;
      }
      setDone({ manualReview: !!data.manualReview, sentTo: data.sentTo || email });
    } catch {
      setError('Something went wrong. Try again.');
    }
    setSubmitting(false);
  }

  if (done) {
    return (
      <div className="space-y-4 p-6 border border-dust bg-white">
        <h2 className="font-serif text-2xl">
          Check your email.
        </h2>
        {done.manualReview ? (
          <p className="text-sm text-charcoal/80 leading-relaxed">
            We didn&rsquo;t have an email on file for {ranchName}, so I&rsquo;ll review
            this one personally before activating the link. Expect a reply
            from me within 24 hours — usually faster.
          </p>
        ) : (
          <p className="text-sm text-charcoal/80 leading-relaxed">
            I sent the magic link to{' '}
            <strong>{done.sentTo}</strong> (the email we already had on file
            for {ranchName}). Click it and you&rsquo;re queued for onboarding.
          </p>
        )}
        <p className="text-sm text-saddle">— Ben</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">
          Your name <span className="text-weathered">*</span>
        </label>
        <input
          type="text"
          required
          value={operatorName}
          onChange={(e) => setOperatorName(e.target.value)}
          placeholder="e.g. Cathryn Kerns"
          className="w-full px-4 py-3 border border-dust bg-white text-sm focus:outline-none focus:border-charcoal transition-colors"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">
          Email <span className="text-weathered">*</span>
        </label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full px-4 py-3 border border-dust bg-white text-sm focus:outline-none focus:border-charcoal transition-colors"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">
          Phone <span className="text-dust">(optional)</span>
        </label>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="(555) 555-5555"
          className="w-full px-4 py-3 border border-dust bg-white text-sm focus:outline-none focus:border-charcoal transition-colors"
        />
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
        {submitting ? 'Sending magic link…' : 'Send me the magic link'}
      </button>
    </form>
  );
}
