'use client';

import { useState } from 'react';
import Link from 'next/link';

// Client form for the prospect opt-out page. NO authentication — legal
// compliance: anyone who finds the listing must be able to remove it
// quickly. The downside (false removals) is mitigated by the Telegram
// alert that fires on every remove + Airtable's reverse-action audit log.
export default function RemoveForm({
  slug,
  ranchName,
}: {
  slug: string;
  ranchName: string;
}) {
  const [contactEmail, setContactEmail] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/prospects/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, contactEmail, reason }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Something went wrong. Try again.');
        setSubmitting(false);
        return;
      }
      setDone(true);
    } catch {
      setError('Something went wrong. Try again.');
    }
    setSubmitting(false);
  }

  if (done) {
    return (
      <div className="space-y-4 p-6 border border-[#A7A29A] bg-white">
        <h2 className="font-[family-name:var(--font-playfair)] text-2xl">
          Done. {ranchName} is off the list.
        </h2>
        <p className="text-sm text-[#0E0E0E]/80 leading-relaxed">
          The listing is hidden from the discover map immediately and the
          public page returns a 404. Search engines will drop the page on
          their next crawl.
        </p>
        <p className="text-sm text-[#0E0E0E]/80 leading-relaxed">
          If this was a mistake, reply to my email and I&rsquo;ll fix it. Same if
          you ever want back on — I&rsquo;ll set the listing back up exactly how
          you want it.
        </p>
        <p className="text-sm text-[#6B4F3F]">— Ben</p>
        <Link
          href="/"
          className="inline-block mt-2 text-sm underline text-[#A7A29A] hover:text-[#0E0E0E]"
        >
          BuyHalfCow home
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">
          Your email <span className="text-[#A7A29A]">(optional)</span>
        </label>
        <input
          type="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          placeholder="so I can confirm if needed"
          className="w-full px-4 py-3 border border-[#A7A29A] bg-white text-sm focus:outline-none focus:border-[#0E0E0E] transition-colors"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">
          Reason <span className="text-[#A7A29A]">(optional)</span>
        </label>
        <textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Helps me improve the discovery process. Not required."
          className="w-full px-4 py-3 border border-[#A7A29A] bg-white text-sm focus:outline-none focus:border-[#0E0E0E] transition-colors resize-vertical"
        />
      </div>

      {error && (
        <div className="p-4 bg-[#8C2F2F]/10 border border-[#8C2F2F] text-[#8C2F2F] text-sm">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full py-4 bg-[#0E0E0E] text-[#F4F1EC] text-sm font-medium tracking-wide hover:bg-[#6B4F3F] transition-colors disabled:opacity-50"
      >
        {submitting ? 'Removing…' : `Remove ${ranchName} from BuyHalfCow`}
      </button>
    </form>
  );
}
