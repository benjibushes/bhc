'use client';

import { useEffect, useState } from 'react';

interface Props {
  token: string;
}

export default function ReviewSubmitForm({ token }: Props) {
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [review, setReview] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // F-4 audit: probe the GET endpoint on mount so we can render the
  // "already submitted" state immediately instead of letting the user
  // fill out a doomed form that 409s on submit.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/reviews/submit?token=${encodeURIComponent(token)}`);
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && data?.alreadySubmitted) {
          setAlreadySubmitted(true);
        }
      } catch {
        // Soft-fail: server-side 409 still catches re-submit.
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (rating < 1) {
      setError('Pick a rating (1-5 stars).');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/reviews/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, rating, review: review.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // F-4: server-side idempotency rejected a second submission.
        // Flip to the friendly "already submitted" view instead of error.
        setAlreadySubmitted(true);
        setSubmitting(false);
        return;
      }
      if (!res.ok) {
        setError(data?.error || 'Could not save — try again.');
        setSubmitting(false);
        return;
      }
      setSubmitted(true);
    } catch (e: any) {
      setError(e?.message || 'Network error — try again.');
      setSubmitting(false);
    }
  }

  if (alreadySubmitted) {
    return (
      <div className="border border-charcoal p-5 md:p-6">
        <p className="font-serif text-lg mb-2">Thanks — you&apos;ve already submitted a review.</p>
        <p className="text-saddle leading-relaxed text-sm md:text-base">
          We&apos;ve got your rating on file. If you want to update it, reply to the email that sent you here and we&apos;ll edit it manually.
        </p>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="border border-charcoal p-5 md:p-6">
        <p className="font-serif text-lg mb-2">Thanks.</p>
        <p className="text-saddle leading-relaxed text-sm md:text-base">
          Your review helps the next family find verified beef. We&apos;ll add your words to the wall in the next day or two.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label className="block text-sm font-semibold text-charcoal mb-2">
          How was it?
        </label>
        <div className="flex gap-1" role="radiogroup" aria-label="Rating from 1 to 5 stars">
          {[1, 2, 3, 4, 5].map((n) => {
            const active = (hoverRating || rating) >= n;
            return (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={rating === n}
                aria-label={`${n} star${n === 1 ? '' : 's'}`}
                onClick={() => setRating(n)}
                onMouseEnter={() => setHoverRating(n)}
                onMouseLeave={() => setHoverRating(0)}
                className={`w-11 h-11 text-2xl leading-none transition-colors ${
                  active ? 'text-charcoal' : 'text-dust'
                }`}
              >
                {active ? '★' : '☆'}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label htmlFor="review" className="block text-sm font-semibold text-charcoal mb-2">
          One sentence (optional)
        </label>
        <textarea
          id="review"
          name="review"
          value={review}
          onChange={(e) => setReview(e.target.value.slice(0, 2000))}
          rows={4}
          maxLength={2000}
          placeholder='e.g. "freezer&apos;s full, family&apos;s fed, talked to the rancher direct."'
          className="w-full border border-dust bg-bone p-3 text-charcoal focus:outline-none focus:border-charcoal text-sm md:text-base"
        />
        <p className="mt-1 text-xs text-saddle">{review.length} / 2000</p>
      </div>

      {error && (
        <div className="border border-weathered bg-bone p-3 text-sm text-weathered">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full bg-charcoal text-bone py-3 min-h-[48px] px-6 uppercase tracking-wider text-sm font-bold hover:bg-saddle disabled:bg-dust disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? 'Sending…' : 'Send review'}
      </button>
    </form>
  );
}
