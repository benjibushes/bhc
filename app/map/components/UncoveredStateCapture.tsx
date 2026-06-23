'use client';

import { useState } from 'react';

// Demand capture for uncovered states. When a visitor filters to a state where
// we have zero pins, we don't want a dead end — we want their email so we can
// notify them when a rancher comes online AND so the operator sees real pull
// for that geography (which states to scout next).
//
// POSTs to the existing /api/waitlist endpoint (the simplest lead-save: writes
// to Consumers tagged Source='relaunch_waitlist', no emails/crons fire). We
// reuse it rather than inventing a new path. The endpoint accepts
// { email, state, interest, notes } and is idempotent on email.
export default function UncoveredStateCapture({ state }: { state: string }) {
  const [email, setEmail] = useState('');
  const [zip, setZip] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === 'submitting' || status === 'done') return;
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Enter your email so we can let you know.');
      setStatus('error');
      return;
    }
    setStatus('submitting');
    setError('');
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: trimmed,
          state,
          interest: 'beef',
          // Zip rides along in notes — the waitlist endpoint doesn't have a
          // dedicated zip field, but the operator wants it for tighter scouting.
          notes: zip.trim() ? `zip=${zip.trim()} (uncovered-state map capture)` : 'uncovered-state map capture',
          referrer: typeof window !== 'undefined' ? window.location.href : '',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || 'Something went wrong — try again.');
        setStatus('error');
        return;
      }
      setStatus('done');
    } catch {
      setError('Network hiccup — try again in a sec.');
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <div className="border border-sage/40 bg-sage/5 px-5 py-6 text-center">
        <p className="font-serif text-xl text-charcoal lowercase">you&rsquo;re on the list</p>
        <p className="text-sm text-saddle mt-1">
          We&rsquo;ll email you the moment a rancher near {state || 'you'} comes online —
          and we&rsquo;re prioritizing scouting your area now.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-dust bg-bone-warm px-5 py-6">
      <p className="font-serif text-xl text-charcoal lowercase">
        no rancher in {state || 'your state'} yet
      </p>
      <p className="text-sm text-saddle mt-1 mb-4">
        Get notified the second one comes online. Drop your email (and zip, so we
        know exactly where to scout) — we&rsquo;ll prioritize bringing a rancher to
        you.
      </p>
      <form onSubmit={onSubmit} className="flex flex-col sm:flex-row gap-2">
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@email.com"
          className="flex-1 px-3 py-3 border border-dust bg-bone text-charcoal text-sm placeholder:text-dust focus:outline-none focus:border-charcoal"
        />
        <input
          type="text"
          inputMode="numeric"
          autoComplete="postal-code"
          value={zip}
          onChange={(e) => setZip(e.target.value.replace(/[^0-9-]/g, '').slice(0, 10))}
          placeholder="zip"
          className="sm:w-24 px-3 py-3 border border-dust bg-bone text-charcoal text-sm placeholder:text-dust focus:outline-none focus:border-charcoal"
          aria-label="ZIP code"
        />
        <button
          type="submit"
          disabled={status === 'submitting'}
          className="px-5 py-3 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider disabled:opacity-60"
        >
          {status === 'submitting' ? 'Saving…' : 'Notify me'}
        </button>
      </form>
      {status === 'error' && error ? (
        <p className="text-xs text-weathered mt-2">{error}</p>
      ) : (
        <p className="text-xs text-dust mt-2">
          No spam. One email when your area opens up.
        </p>
      )}
    </div>
  );
}
