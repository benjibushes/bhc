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
          // Real field now (2026-07-25) — /api/waitlist validates this with
          // normalizeZip and writes Consumers.`Zip`, so these buyers can
          // actually be placed by distance + service-area routing. The notes
          // copy stays for the operator's scouting history.
          zip: zip.trim(),
          notes: zip.trim() ? `zip=${zip.trim()} (uncovered-state map capture)` : 'uncovered-state map capture',
          referrer: typeof window !== 'undefined' ? window.location.href : '',
        }),
      });
      const data = await res.json().catch(() => ({}));
      // HONEST SUCCESS ONLY (Wave 2 buyer UI 2026-08-01). The API has two
      // failure shapes in the wild — the legacy { ok:true, captured:false }
      // (write failed but the route still 200'd) and the newer
      // { ok:false, error:'capture-failed' }. This component used to render
      // "you're on the list" for the first one — a fake confirmation on a
      // lead that was never saved. Both now land on the retry state.
      const captured = res.ok && data?.ok !== false && data?.captured !== false;
      if (!captured) {
        setError(
          data?.error === 'capture-failed' || data?.captured === false
            ? 'That didn’t save on our end — give it one more try.'
            : data?.error || 'Something went wrong — try again.',
        );
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
        {/* Promise only what actually happens today: the capture logs demand
            for the operator's scouting queue — there is no automated
            "the moment one comes online" email rail. */}
        <p className="text-sm text-saddle mt-1">
          We log demand and recruit ranchers where it&rsquo;s strongest — you&rsquo;ll
          hear from us when {state || 'your area'} opens up.
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
        Drop your email (and zip, so we know exactly where to scout). We log
        demand and recruit ranchers where it&rsquo;s strongest — you&rsquo;ll hear
        from us when your area opens.
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
          className="flex-1 px-3 py-3 border border-dust bg-bone text-charcoal text-sm placeholder:text-dust focus:border-charcoal"
        />
        <input
          type="text"
          inputMode="numeric"
          autoComplete="postal-code"
          value={zip}
          onChange={(e) => setZip(e.target.value.replace(/[^0-9-]/g, '').slice(0, 10))}
          placeholder="zip"
          className="sm:w-24 px-3 py-3 border border-dust bg-bone text-charcoal text-sm placeholder:text-dust focus:border-charcoal"
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
        <p role="alert" className="text-xs text-weathered mt-2">{error}</p>
      ) : (
        <p className="text-xs text-muted mt-2">
          No spam — just a heads-up when your area opens.
        </p>
      )}
    </div>
  );
}
