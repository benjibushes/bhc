// app/qualify/[consumerId]/page.tsx
//
// QUALIFICATION QUIZ — gamified 4-step gate before rancher routing.
//
// Lands here from /api/warmup/engage YES click. Token in query string
// authorizes a single consumerId. Buyer answers 4 quick card-based questions,
// sees a progress bar fill, gets a score reveal w/ star rating, then sees
// dual-path CTA:
//   Path A: "Meet your rancher" → /matched
//   Path B (tier_v2 only): "Reserve your share — $X deposit" → /checkout/<refId>/deposit
//
// Designed so the rancher gets a buyer who has already committed to size,
// timing, storage situation, and acknowledged the buying process. Eliminates
// the "window shopper" leak from a single-click YES button.

'use client';

import { useState, useEffect, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';

const TIER_OPTIONS = [
  { value: 'Quarter', label: 'Quarter', sub: '~85 lbs · ~$1,000-$1,500' },
  { value: 'Half', label: 'Half', sub: '~170 lbs · ~$2,000-$2,500' },
  { value: 'Whole', label: 'Whole', sub: '~340 lbs · ~$4,000-$5,000' },
  { value: 'Not Sure', label: 'Not sure yet', sub: 'I want to talk through options' },
] as const;

const TIMING_OPTIONS = [
  { value: 'ASAP', label: 'ASAP', sub: 'Next available processing date' },
  { value: 'Within 30 days', label: 'Within 30 days', sub: "I'm ready to lock something in" },
  { value: 'Within 60 days', label: 'Within 60 days', sub: 'Planning ahead' },
  { value: 'Within 90 days', label: 'Within 90 days', sub: 'Earlier next quarter' },
  { value: 'Just exploring', label: 'Just exploring', sub: 'No timeline yet' },
] as const;

const STORAGE_OPTIONS = [
  { value: 'have_freezer', label: 'I have freezer space', sub: 'Standalone chest or upright ready' },
  { value: 'need_freezer', label: 'Need to buy a freezer', sub: 'Will get one before pickup/delivery' },
  { value: 'rancher_holds', label: 'Need rancher to hold short-term', sub: 'I can pick up in batches' },
  { value: 'cuts_only', label: 'Pickup cuts only', sub: "Don't need full half/whole at once" },
] as const;

export default function QualifyPage({
  params,
  searchParams,
}: {
  params: Promise<{ consumerId: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { consumerId } = usePromise(params);
  const { token } = usePromise(searchParams);
  const router = useRouter();

  // Steps 0-3 = questions. Step 4 = score reveal. Step 5 = dual-path CTA.
  const [step, setStep] = useState(0);
  const [tier, setTier] = useState<string>('');
  const [timing, setTiming] = useState<string>('');
  const [storage, setStorage] = useState<string>('');
  const [ack, setAck] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    qualified: boolean;
    score: number;
    routingOk?: boolean;
    rancher?: { name: string; state: string; slug: string } | null;
    referralId?: string | null;
    pricingModel?: string;
    depositAmount?: number | null;
    message?: string;
  } | null>(null);
  const [pathChosen, setPathChosen] = useState<'rancher_meet' | 'direct_deposit' | null>(null);

  useEffect(() => {
    if (!token) {
      setError('Missing qualification token. Click the "Yes — Ready to Buy" button in your email again.');
    }
  }, [token]);

  const totalSteps = 4;
  const progress = Math.round((step / totalSteps) * 100);
  const canAdvance =
    (step === 0 && !!tier) ||
    (step === 1 && !!timing) ||
    (step === 2 && !!storage) ||
    (step === 3 && ack);

  async function submit() {
    if (!token) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/qualify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          consumerId,
          answers: { tier, timing, storage, ack },
        }),
      });
      const j = await res.json();
      if (!res.ok) {
        setError(j.error || 'Could not submit. Try again or reply to the email.');
        setSubmitting(false);
        return;
      }
      setResult(j);
      setStep(4);
    } catch (e: any) {
      setError(e?.message || 'Network error. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function choosePath(path: 'rancher_meet' | 'direct_deposit') {
    if (!token || !result) return;
    setPathChosen(path);
    // Fire-and-forget path stamp; navigation doesn't depend on it.
    try {
      await fetch('/api/qualify', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, consumerId, path }),
      });
    } catch {}
    if (path === 'direct_deposit' && result.referralId) {
      router.push(`/checkout/${result.referralId}/deposit`);
    } else if (result.rancher) {
      router.push(
        `/matched?rancher=${encodeURIComponent(result.rancher.name)}&state=${encodeURIComponent(result.rancher.state)}`
      );
    } else {
      router.push('/member?qualified=true');
    }
  }

  if (error && step < 4) {
    return (
      <main className="min-h-screen bg-bone flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-dust p-7 text-center">
          <h1 className="font-serif text-2xl text-charcoal mb-3">Something went sideways</h1>
          <p className="text-saddle text-sm">{error}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-bone py-10 px-4 md:py-16">
      <div className="max-w-2xl mx-auto">
        {/* Progress bar */}
        {step < 4 && (
          <div className="mb-8">
            <div className="flex justify-between text-xs uppercase tracking-widest text-saddle mb-2">
              <span>Step {step + 1} of {totalSteps}</span>
              <span>{progress}% qualified</span>
            </div>
            <div className="h-2 bg-dust/50 overflow-hidden">
              <div
                className="h-full bg-charcoal transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {/* STEP 0 — TIER */}
        {step === 0 && (
          <section className="space-y-5">
            <header>
              <p className="text-xs uppercase tracking-widest text-saddle mb-2">Question 1</p>
              <h1 className="font-serif text-3xl text-charcoal">What size are you looking for?</h1>
              <p className="text-sm text-saddle mt-1">Pick the closest fit. You can refine on the call.</p>
            </header>
            <div className="grid gap-3">
              {TIER_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTier(opt.value)}
                  className={`text-left border p-4 transition-all ${
                    tier === opt.value
                      ? 'border-charcoal bg-charcoal text-bone'
                      : 'border-dust bg-white text-charcoal hover:border-saddle'
                  }`}
                >
                  <div className="font-medium">{opt.label}</div>
                  <div className={`text-sm mt-0.5 ${tier === opt.value ? 'text-bone/80' : 'text-saddle'}`}>
                    {opt.sub}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* STEP 1 — TIMING */}
        {step === 1 && (
          <section className="space-y-5">
            <header>
              <p className="text-xs uppercase tracking-widest text-saddle mb-2">Question 2</p>
              <h1 className="font-serif text-3xl text-charcoal">When are you looking to buy?</h1>
              <p className="text-sm text-saddle mt-1">Ranchers process on cycles — timing helps us match you to the right slot.</p>
            </header>
            <div className="grid gap-3">
              {TIMING_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTiming(opt.value)}
                  className={`text-left border p-4 transition-all ${
                    timing === opt.value
                      ? 'border-charcoal bg-charcoal text-bone'
                      : 'border-dust bg-white text-charcoal hover:border-saddle'
                  }`}
                >
                  <div className="font-medium">{opt.label}</div>
                  <div className={`text-sm mt-0.5 ${timing === opt.value ? 'text-bone/80' : 'text-saddle'}`}>
                    {opt.sub}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* STEP 2 — STORAGE */}
        {step === 2 && (
          <section className="space-y-5">
            <header>
              <p className="text-xs uppercase tracking-widest text-saddle mb-2">Question 3</p>
              <h1 className="font-serif text-3xl text-charcoal">Where will you store it?</h1>
              <p className="text-sm text-saddle mt-1">A whole cow is ~340 lbs of frozen beef. Half is ~170. Your rancher needs to know the plan.</p>
            </header>
            <div className="grid gap-3">
              {STORAGE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setStorage(opt.value)}
                  className={`text-left border p-4 transition-all ${
                    storage === opt.value
                      ? 'border-charcoal bg-charcoal text-bone'
                      : 'border-dust bg-white text-charcoal hover:border-saddle'
                  }`}
                >
                  <div className="font-medium">{opt.label}</div>
                  <div className={`text-sm mt-0.5 ${storage === opt.value ? 'text-bone/80' : 'text-saddle'}`}>
                    {opt.sub}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* STEP 3 — COMMITMENT ACK */}
        {step === 3 && (
          <section className="space-y-5">
            <header>
              <p className="text-xs uppercase tracking-widest text-saddle mb-2">Question 4 (last one)</p>
              <h1 className="font-serif text-3xl text-charcoal">Quick acknowledgment</h1>
              <p className="text-sm text-saddle mt-1">
                Make sure we&apos;re on the same page before we connect you with a real rancher.
              </p>
            </header>
            <div
              className={`border p-5 transition-all cursor-pointer ${
                ack ? 'border-charcoal bg-charcoal text-bone' : 'border-dust bg-white text-charcoal hover:border-saddle'
              }`}
              onClick={() => setAck(!ack)}
            >
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                  className="mt-1 w-5 h-5 cursor-pointer"
                />
                <div className="flex-1">
                  <div className="font-medium">I understand and agree:</div>
                  <ul className={`text-sm mt-2 space-y-1 list-disc pl-5 ${ack ? 'text-bone/90' : 'text-saddle'}`}>
                    <li>Processing typically takes 2-4 weeks from booking</li>
                    <li>Total purchase is ~$1,000-$5,000 depending on size</li>
                    <li>I&apos;ll respond to my rancher within 24 hours</li>
                    <li>This connects me with a real, verified rancher (not a marketplace)</li>
                  </ul>
                </div>
              </label>
            </div>
          </section>
        )}

        {/* STEP 4 — SCORE REVEAL */}
        {step === 4 && result && (
          <section className="space-y-6 text-center">
            {result.qualified ? (
              <>
                <div className="text-6xl">⭐⭐⭐⭐⭐</div>
                <header>
                  <p className="text-xs uppercase tracking-widest text-saddle mb-2">You scored {result.score}/100</p>
                  <h1 className="font-serif text-4xl text-charcoal">You&apos;re qualified.</h1>
                  <p className="text-saddle mt-3 text-base max-w-md mx-auto">
                    {result.routingOk && result.rancher
                      ? `Matched with ${result.rancher.name} in ${result.rancher.state}. Choose how you want to connect:`
                      : "We're holding your spot — the next rancher who opens up in your state gets you first."}
                  </p>
                </header>

                {result.routingOk && result.rancher && (
                  <div className="grid gap-4 mt-8">
                    {/* Path A — Meet your rancher */}
                    <button
                      onClick={() => choosePath('rancher_meet')}
                      disabled={!!pathChosen}
                      className="border-2 border-charcoal bg-white hover:bg-bone p-6 text-left transition-all disabled:opacity-50"
                    >
                      <div className="flex items-start gap-4">
                        <div className="text-3xl">📅</div>
                        <div className="flex-1">
                          <div className="font-serif text-xl text-charcoal">Meet your rancher</div>
                          <div className="text-sm text-saddle mt-1">
                            {result.rancher.name} will reach out — schedule a 15-min call, ask questions, lock in pricing.
                          </div>
                        </div>
                        <div className="text-charcoal font-medium">→</div>
                      </div>
                    </button>

                    {/* Path B — Direct deposit (tier_v2 only) */}
                    {result.pricingModel === 'tier_v2' && result.depositAmount && result.referralId && (
                      <button
                        onClick={() => choosePath('direct_deposit')}
                        disabled={!!pathChosen}
                        className="border-2 border-charcoal bg-charcoal text-bone hover:bg-saddle hover:border-saddle p-6 text-left transition-all disabled:opacity-50"
                      >
                        <div className="flex items-start gap-4">
                          <div className="text-3xl">💳</div>
                          <div className="flex-1">
                            <div className="font-serif text-xl">Reserve your share now</div>
                            <div className="text-sm text-bone/90 mt-1">
                              Skip the call — pay ${result.depositAmount} deposit, lock in your slot for the next processing run. Rancher invoices the balance after processing.
                            </div>
                          </div>
                          <div className="font-medium">→</div>
                        </div>
                      </button>
                    )}
                  </div>
                )}

                {!result.routingOk && (
                  <button
                    onClick={() => router.push('/member?qualified=true')}
                    className="inline-block mt-6 px-7 py-3.5 bg-charcoal text-bone hover:bg-saddle transition-colors font-medium uppercase tracking-widest text-xs"
                  >
                    Go to my dashboard
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="text-5xl">🐂</div>
                <header>
                  <p className="text-xs uppercase tracking-widest text-saddle mb-2">Score: {result.score}/100</p>
                  <h1 className="font-serif text-3xl text-charcoal">Not quite ready yet</h1>
                  <p className="text-saddle mt-3 max-w-md mx-auto">{result.message}</p>
                </header>
                <button
                  onClick={() => router.push('/member?qualified=incomplete')}
                  className="inline-block mt-4 px-7 py-3.5 bg-charcoal text-bone hover:bg-saddle transition-colors font-medium uppercase tracking-widest text-xs"
                >
                  Go to my dashboard
                </button>
              </>
            )}
          </section>
        )}

        {/* Footer nav — only on quiz steps */}
        {step < 4 && (
          <div className="flex items-center justify-between mt-8">
            <button
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0 || submitting}
              className="text-sm text-saddle hover:text-charcoal disabled:opacity-30 disabled:cursor-not-allowed"
            >
              ← Back
            </button>
            {step < totalSteps - 1 ? (
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={!canAdvance || submitting}
                className="px-7 py-3 bg-charcoal text-bone hover:bg-saddle transition-colors font-medium uppercase tracking-widest text-xs disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Next →
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!canAdvance || submitting}
                className="px-7 py-3 bg-charcoal text-bone hover:bg-saddle transition-colors font-medium uppercase tracking-widest text-xs disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {submitting ? 'Qualifying…' : 'See my match →'}
              </button>
            )}
          </div>
        )}

        {error && step >= 4 && (
          <p className="text-sm text-red-600 mt-4 text-center">{error}</p>
        )}
      </div>
    </main>
  );
}
