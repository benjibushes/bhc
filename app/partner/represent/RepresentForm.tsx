'use client';

import { useState } from 'react';

// The agreement checkbox is REQUIRED and the endpoint re-validates it
// (agreedToCommission === true). The rancher funds BHC's commission out of his
// own price, so his acceptance has to be an explicit act here — not an implied
// consequence of pressing submit.

const FIELD =
  'mt-1 w-full rounded-sm border border-stone-300 bg-white px-3 py-2 text-stone-900 outline-none focus:border-stone-900';

export default function RepresentForm() {
  const [state, setState] = useState({
    ranchName: '',
    contactName: '',
    email: '',
    phone: '',
    state: '',
    sells: '',
    balanceNote: '',
    website_url: '', // honeypot
  });
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  function set(k: keyof typeof state, v: string) {
    setState((s) => ({ ...s, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/partner/represent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...state, agreedToCommission: agreed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || 'Something went wrong. Please try again.');
        setSubmitting(false);
        return;
      }
      setDone(data?.message || "You're set up. We'll email you the moment a share sells.");
    } catch {
      setError('Something went wrong. Please try again.');
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <section className="mt-10 rounded-sm border border-stone-900 bg-stone-50 p-6">
        <h2 className="font-serif text-2xl">You&apos;re set up</h2>
        <p className="mt-3 text-stone-700">{done}</p>
        <p className="mt-3 text-sm text-stone-600">
          We just emailed you a copy of how this works. There is nothing else to do — no account, no
          login, no app.
        </p>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="mt-10 space-y-4">
      <h2 className="font-serif text-2xl">Get set up</h2>

      {/* Honeypot — hidden from humans, catches bots. */}
      <input
        type="text"
        name="website_url"
        tabIndex={-1}
        autoComplete="off"
        value={state.website_url}
        onChange={(e) => set('website_url', e.target.value)}
        className="hidden"
        aria-hidden="true"
      />

      <label className="block text-sm font-medium text-stone-800">
        Ranch name
        <input required className={FIELD} value={state.ranchName} onChange={(e) => set('ranchName', e.target.value)} />
      </label>

      <label className="block text-sm font-medium text-stone-800">
        Your name
        <input required className={FIELD} value={state.contactName} onChange={(e) => set('contactName', e.target.value)} />
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium text-stone-800">
          Email
          <input required type="email" className={FIELD} value={state.email} onChange={(e) => set('email', e.target.value)} />
        </label>
        {/* Phone + State demoted to optional (2026-08-02 friction cut): email
            is the rail's only required channel — the server no longer 400s on
            either, and this is a one-page speed play. */}
        <label className="block text-sm font-medium text-stone-800">
          Phone <span className="font-normal text-stone-500">(optional)</span>
          <input type="tel" className={FIELD} value={state.phone} onChange={(e) => set('phone', e.target.value)} />
        </label>
      </div>

      <label className="block text-sm font-medium text-stone-800">
        State <span className="font-normal text-stone-500">(optional)</span>
        <input
          placeholder="MT"
          className={FIELD}
          value={state.state}
          onChange={(e) => set('state', e.target.value)}
        />
      </label>

      <label className="block text-sm font-medium text-stone-800">
        What do you sell?
        <textarea
          rows={3}
          placeholder="Grass-fed halves and quarters, dry-aged 21 days, cut to order."
          className={FIELD}
          value={state.sells}
          onChange={(e) => set('sells', e.target.value)}
        />
      </label>

      <label className="block text-sm font-medium text-stone-800">
        How should buyers pay you the balance?
        <textarea
          rows={2}
          placeholder="Cash or check at pickup."
          className={FIELD}
          value={state.balanceNote}
          onChange={(e) => set('balanceNote', e.target.value)}
        />
        <span className="mt-1 block text-xs font-normal text-stone-500">
          We put this in the buyer&apos;s receipt so they know exactly how to pay you.
        </span>
      </label>

      <label className="flex items-start gap-3 rounded-sm border border-stone-300 bg-stone-50 p-4 text-sm text-stone-800">
        <input
          type="checkbox"
          required
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-1"
        />
        <span>
          I understand that <strong>BuyHalfCow collects the buyer&apos;s deposit as its commission</strong>,
          that I receive the balance directly from the buyer, and that my net on each share is my
          price minus that deposit.
        </span>
      </label>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <button
        type="submit"
        disabled={submitting || !agreed}
        className="w-full rounded-sm bg-stone-900 px-5 py-4 text-white disabled:opacity-40"
      >
        {submitting ? 'Setting you up…' : 'Set me up'}
      </button>
    </form>
  );
}
