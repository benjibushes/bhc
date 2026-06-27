'use client';

// Flawless-handoff (2026-06-27): post-deposit buyer preferences form.
//
// The buyer just paid. This is the one place they tell the rancher HOW they
// want their beef — delivery vs pickup, a target window, and cut-sheet notes —
// which POSTs to /api/checkout/[refId]/preferences (seeds the rancher thread +
// stamps the referral). Lean, on-brand, single submit, thank-you state.

import { Suspense, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

type Fulfillment = 'pickup' | 'delivery' | '';

export default function PreferencesPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bone text-charcoal flex items-center justify-center"><p>Loading…</p></div>}>
      <PreferencesContent />
    </Suspense>
  );
}

function PreferencesContent() {
  const params = useParams<{ refId: string }>();
  const refId = params.refId;

  const [rancherName, setRancherName] = useState('your rancher');
  const [fulfillment, setFulfillment] = useState<Fulfillment>('');
  const [windowPref, setWindowPref] = useState('');
  const [cutNotes, setCutNotes] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/checkout/${refId}/preferences`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.error) {
          setError(j.error);
        } else {
          setRancherName(j.rancherName || 'your rancher');
          if (j.preferences) {
            setFulfillment(j.preferences.fulfillment || '');
            setWindowPref(j.preferences.window || '');
            setCutNotes(j.preferences.cutNotes || '');
          }
        }
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message || 'Load failed');
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refId]);

  // Special-case the "your rancher" default so a missing name reads cleanly
  // ("Tell your rancher how you want it" — not "Tell your how you want it").
  const rancherFirst = rancherName === 'your rancher' ? 'your rancher' : rancherName.split(' ')[0];

  const submit = async () => {
    if (!fulfillment) {
      setError('Pick delivery or pickup first.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`/api/checkout/${refId}/preferences`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fulfillment, window: windowPref, cutNotes }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j?.error || 'Something went wrong. Try again.');
      } else {
        setDone(true);
      }
    } catch (e: any) {
      setError(e?.message || 'Network error. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <main className="min-h-screen bg-bone text-charcoal">
        <div className="max-w-xl mx-auto px-4 md:px-6 py-12 md:py-16">
          <h1 className="font-serif text-3xl md:text-4xl mb-3">Got it — thank you.</h1>
          <p className="text-saddle mb-8 text-base md:text-lg">
            We passed your preferences to {rancherFirst}. They&rsquo;ll have them in hand when they reach out to set up your beef.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <Link
              href={`/checkout/${refId}/ask`}
              className="flex-1 text-center bg-charcoal text-bone px-6 py-3 min-h-[48px] flex items-center justify-center uppercase tracking-wider text-sm hover:bg-saddle transition"
            >
              Message {rancherFirst} &rarr;
            </Link>
            <Link
              href="/member"
              className="flex-1 text-center bg-bone border border-charcoal text-charcoal px-6 py-3 min-h-[48px] flex items-center justify-center uppercase tracking-wider text-sm hover:bg-divider hover:text-bone transition"
            >
              Your dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="max-w-xl mx-auto px-4 md:px-6 py-8 md:py-12">
        <h1 className="font-serif text-3xl md:text-4xl mb-2">Tell {rancherFirst} how you want it.</h1>
        <p className="text-saddle mb-6 md:mb-8 text-base md:text-lg">
          A few quick answers so {rancherFirst} can get your beef ready the way you like. Takes 30 seconds.
        </p>

        {error && (
          <div className="border-l-4 border-saddle bg-white p-3 mb-5 text-sm text-charcoal">{error}</div>
        )}

        {/* Fulfillment — delivery vs pickup */}
        <fieldset className="mb-6">
          <legend className="font-serif text-lg md:text-xl mb-3">Delivery or pickup?</legend>
          <div className="grid grid-cols-2 gap-3">
            {(['pickup', 'delivery'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setFulfillment(opt)}
                className={`px-4 py-3 min-h-[48px] border text-sm uppercase tracking-wider transition ${
                  fulfillment === opt
                    ? 'bg-charcoal text-bone border-charcoal'
                    : 'bg-white text-charcoal border-dust hover:border-charcoal'
                }`}
                aria-pressed={fulfillment === opt}
              >
                {opt === 'pickup' ? 'Pickup' : 'Delivery'}
              </button>
            ))}
          </div>
        </fieldset>

        {/* Target window */}
        <div className="mb-6">
          <label htmlFor="window" className="block font-serif text-lg md:text-xl mb-2">
            When would you like it?
          </label>
          <input
            id="window"
            type="text"
            value={windowPref}
            onChange={(e) => setWindowPref(e.target.value)}
            placeholder="e.g. mid-July, or after the 20th, or as soon as it's ready"
            className="w-full px-4 py-3 min-h-[48px] bg-white border border-dust text-charcoal placeholder:text-dust focus:border-charcoal focus:outline-none"
          />
        </div>

        {/* Cut notes */}
        <div className="mb-8">
          <label htmlFor="cutNotes" className="block font-serif text-lg md:text-xl mb-2">
            Anything on the cut sheet?
          </label>
          <textarea
            id="cutNotes"
            value={cutNotes}
            onChange={(e) => setCutNotes(e.target.value)}
            rows={4}
            placeholder="e.g. thick ribeyes, extra ground, keep the soup bones & oxtail, no liver. Or leave blank and trust their standard cut."
            className="w-full px-4 py-3 bg-white border border-dust text-charcoal placeholder:text-dust focus:border-charcoal focus:outline-none resize-y"
          />
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={submitting || !loaded}
          className="w-full bg-charcoal text-bone px-6 py-3 min-h-[52px] uppercase tracking-wider text-sm hover:bg-saddle transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'Sending…' : `Send to ${rancherFirst}`}
        </button>

        <p className="mt-5 text-center text-saddle text-sm">
          Not sure yet? You can also{' '}
          <Link href={`/checkout/${refId}/ask`} className="underline">
            message {rancherFirst} directly
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
