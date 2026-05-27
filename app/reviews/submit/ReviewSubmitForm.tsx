'use client';

import { useState } from 'react';

interface Props {
  token: string;
}

export default function ReviewSubmitForm({ token }: Props) {
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [review, setReview] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (submitted) {
    return (
      <div className="border border-[#0E0E0E] p-6">
        <p className="font-serif text-lg mb-2">Thanks.</p>
        <p className="text-[#6B4F3F]">
          That means a lot. We'll add your words to the wall in the next day or two.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label className="block text-sm font-semibold text-[#0E0E0E] mb-2">
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
                className={`w-10 h-10 text-2xl leading-none transition-colors ${
                  active ? 'text-[#0E0E0E]' : 'text-[#A7A29A]'
                }`}
              >
                {active ? '★' : '☆'}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label htmlFor="review" className="block text-sm font-semibold text-[#0E0E0E] mb-2">
          One sentence (optional)
        </label>
        <textarea
          id="review"
          name="review"
          value={review}
          onChange={(e) => setReview(e.target.value.slice(0, 2000))}
          rows={4}
          maxLength={2000}
          placeholder='e.g. "freezer’s full, family’s fed, talked to the rancher direct."'
          className="w-full border border-[#A7A29A] bg-[#F4F1EC] p-3 text-[#0E0E0E] focus:outline-none focus:border-[#0E0E0E]"
        />
        <p className="mt-1 text-xs text-[#A7A29A]">{review.length} / 2000</p>
      </div>

      {error && (
        <div className="border border-[#6B4F3F] bg-[#F4F1EC] p-3 text-sm text-[#6B4F3F]">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full bg-[#0E0E0E] text-[#F4F1EC] py-3 px-6 uppercase tracking-wider text-sm font-bold hover:bg-[#6B4F3F] disabled:bg-[#A7A29A] disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? 'Sending…' : 'Send review'}
      </button>
    </form>
  );
}
