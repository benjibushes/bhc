'use client';

// app/update-profile/page.tsx
//
// Landing page for the backfill survey emails (admin/manual sends), which link
// to `${siteUrl}/update-profile?token=<jwt>`. Previously this page did not
// exist → every recipient hit a hard 404 (Email QA findings, Audit B, P0).
//
// Flow:
//   1. Read ?token from the URL.
//   2. POST it to /api/backfill/validate-token to confirm the backfill JWT and
//      hydrate the buyer's name/email/state.
//   3. Render a simple profile-update form (order type / budget / notes).
//   4. POST the answers + token to /api/backfill/update-profile.
//
// The form's order-type + budget options mirror the brackets that
// /api/backfill/update-profile's calculateIntentScore expects, so the score
// computes correctly. Styling matches the site (bone/charcoal/saddle/dust
// Tailwind tokens + shared Container/Divider), same idiom as /member/login.

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Container from '../components/Container';
import Divider from '../components/Divider';

const ORDER_TYPES = ['Quarter', 'Half', 'Whole'] as const;
const BUDGET_RANGES = ['$500-$1000', '$1000-$2000', '$2000+'] as const;

function UpdateProfileInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';

  const [status, setStatus] = useState<'validating' | 'ready' | 'invalid' | 'saving' | 'done'>(
    'validating',
  );
  const [name, setName] = useState('');
  const [stateLabel, setStateLabel] = useState('');
  const [error, setError] = useState('');

  const [orderType, setOrderType] = useState('');
  const [budgetRange, setBudgetRange] = useState('');
  const [notes, setNotes] = useState('');

  // ── Validate the token on mount ───────────────────────────────────────────
  useEffect(() => {
    if (!token) {
      setStatus('invalid');
      setError('This link is missing its token. Please use the link from your email.');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/backfill/validate-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (data?.valid) {
          setName(String(data.name || '').split(' ')[0] || '');
          setStateLabel(String(data.state || ''));
          setStatus('ready');
        } else {
          setStatus('invalid');
          setError(
            data?.error === 'Token expired'
              ? 'This link has expired. Reply to the email and we’ll send a fresh one.'
              : 'This link is no longer valid. Reply to the email and we’ll sort it out.',
          );
        }
      } catch {
        if (cancelled) return;
        setStatus('invalid');
        setError('We couldn’t verify your link. Please try again in a minute.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setStatus('saving');
    try {
      const res = await fetch('/api/backfill/update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, orderType, budgetRange, notes }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || 'Could not save your details. Please try again.');
      }
      setStatus('done');
    } catch (err: any) {
      setStatus('ready');
      setError(err?.message || 'Could not save your details. Please try again.');
    }
  };

  // ── Validating ────────────────────────────────────────────────────────────
  if (status === 'validating') {
    return (
      <main className="min-h-screen py-24 bg-bone text-charcoal flex items-center justify-center">
        <Container>
          <div className="max-w-md mx-auto text-center space-y-4">
            <p className="text-saddle">Checking your link…</p>
          </div>
        </Container>
      </main>
    );
  }

  // ── Invalid / expired token ────────────────────────────────────────────────
  if (status === 'invalid') {
    return (
      <main className="min-h-screen py-24 bg-bone text-charcoal flex items-center justify-center">
        <Container>
          <div className="max-w-md mx-auto bg-white border border-dust p-7 md:p-8 text-center space-y-4">
            <div className="text-4xl">🐂</div>
            <h1 className="font-serif text-2xl">This link isn&apos;t working</h1>
            <Divider />
            <p className="text-sm text-saddle leading-relaxed">{error}</p>
          </div>
        </Container>
      </main>
    );
  }

  // ── Saved ─────────────────────────────────────────────────────────────────
  if (status === 'done') {
    return (
      <main className="min-h-screen py-24 bg-bone text-charcoal flex items-center justify-center">
        <Container>
          <div className="max-w-md mx-auto text-center space-y-6">
            <h1 className="font-serif text-4xl">You&apos;re all set</h1>
            <Divider />
            <p className="text-lg text-saddle leading-relaxed">
              Thanks{name ? `, ${name}` : ''} — we&apos;ve updated your preferences. We&apos;ll use them to match you
              with the right rancher.
            </p>
            <p className="text-sm text-dust">You can close this tab.</p>
          </div>
        </Container>
      </main>
    );
  }

  // ── Form (ready / saving) ──────────────────────────────────────────────────
  const saving = status === 'saving';
  return (
    <main className="min-h-screen py-24 bg-bone text-charcoal flex items-center justify-center">
      <Container>
        <div className="max-w-md mx-auto">
          <div className="text-center space-y-4 mb-10">
            <h1 className="font-serif text-4xl">Tell us what you&apos;re after</h1>
            <Divider />
            <p className="text-saddle">
              {name ? `Hi ${name} — ` : ''}help us match you to the right rancher
              {stateLabel ? ` in ${stateLabel}` : ''}. Takes about 30 seconds.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-8">
            <div>
              <label className="block text-xs uppercase tracking-widest text-saddle mb-3">
                How much beef?
              </label>
              <div className="grid grid-cols-3 gap-2">
                {ORDER_TYPES.map((opt) => (
                  <button
                    type="button"
                    key={opt}
                    onClick={() => setOrderType(opt)}
                    className={`px-3 py-3 border text-sm font-medium transition-colors ${
                      orderType === opt
                        ? 'bg-charcoal text-bone border-charcoal'
                        : 'bg-white text-charcoal border-dust hover:border-saddle'
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs uppercase tracking-widest text-saddle mb-3">
                Budget
              </label>
              <div className="grid grid-cols-3 gap-2">
                {BUDGET_RANGES.map((opt) => (
                  <button
                    type="button"
                    key={opt}
                    onClick={() => setBudgetRange(opt)}
                    className={`px-3 py-3 border text-sm font-medium transition-colors ${
                      budgetRange === opt
                        ? 'bg-charcoal text-bone border-charcoal'
                        : 'bg-white text-charcoal border-dust hover:border-saddle'
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label
                htmlFor="notes"
                className="block text-xs uppercase tracking-widest text-saddle mb-3"
              >
                Anything else? <span className="text-dust normal-case tracking-normal">(optional)</span>
              </label>
              <textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="Cut preferences, timing, freezer space…"
                className="w-full border border-dust bg-white px-4 py-3 text-charcoal placeholder:text-dust focus:border-saddle focus:outline-none"
              />
            </div>

            {error ? <p className="text-sm text-saddle">{error}</p> : null}

            <button
              type="submit"
              disabled={saving || !orderType || !budgetRange}
              className="w-full px-7 py-4 bg-charcoal text-bone hover:bg-saddle transition-colors font-medium uppercase tracking-widest text-xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : 'Save my preferences'}
            </button>
          </form>
        </div>
      </Container>
    </main>
  );
}

export default function UpdateProfilePage() {
  // useSearchParams requires a Suspense boundary in the App Router.
  return (
    <Suspense
      fallback={
        <main className="min-h-screen py-24 bg-bone text-charcoal flex items-center justify-center">
          <Container>
            <div className="max-w-md mx-auto text-center">
              <p className="text-saddle">Loading…</p>
            </div>
          </Container>
        </main>
      }
    >
      <UpdateProfileInner />
    </Suspense>
  );
}
