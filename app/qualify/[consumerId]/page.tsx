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
import { CutBreakdown, type Tier as CutTier } from '@/app/components/CutBreakdown';

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
  // `campaign` arrives when /access redirected a rancher-page lead to /qualify.
  // Forwarded to POST /api/qualify so matching/suggest can pin the rancher.
  searchParams: Promise<{ token?: string; campaign?: string }>;
}) {
  const { consumerId } = usePromise(params);
  const { token, campaign } = usePromise(searchParams);
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
    rancher?: {
      name: string;
      state: string;
      slug: string;
      city?: string;
      logoUrl?: string;
      tagline?: string;
      aboutText?: string;
      beefTypes?: string;
      certifications?: string;
      processingFacility?: string;
      nextProcessingDate?: string;
    } | null;
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
          // Preserve rancher-page-lead pinning through the quiz.
          ...(campaign && campaign.startsWith('rancher-') ? { campaign } : {}),
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
      // F2 — fire CompleteRegistration to Meta Pixel + dedupe w/ server CAPI.
      // Critical signal for ad optimization: only qualified buyers reach this
      // step. event_id ties client+server fires per Meta dedup spec.
      try {
        const { track } = await import('@/lib/track');
        const eventId = `qualify-${consumerId}-${Date.now()}`;
        track('CompleteRegistration', {
          orderType: tier,
          value: j.depositAmount || 0,
          event_id: eventId,
        });
        // Also POST eventId back so server CAPI can dedup (next ship).
      } catch { /* non-fatal */ }
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
        <div className="max-w-md w-full bg-white border border-dust p-7 md:p-8 text-center space-y-4">
          <div className="text-4xl">🐂</div>
          <p className="text-xs uppercase tracking-widest text-saddle">Match confirmation</p>
          <h1 className="font-serif text-2xl text-charcoal">Looks like your invite link expired</h1>
          <p className="text-sm text-saddle leading-relaxed">{error}</p>
          <p className="text-sm text-saddle">
            Easiest fix: start a fresh application below. Takes 30 seconds and you&apos;ll
            get a new invite within a minute.
          </p>
          <div className="pt-2">
            <a
              href="/access"
              className="inline-block px-7 py-3 bg-charcoal text-bone hover:bg-saddle transition-colors font-medium uppercase tracking-widest text-xs"
            >
              Start your application →
            </a>
          </div>
          <p className="text-xs text-dust pt-3 border-t border-dust">
            Already applied? Check your inbox for the &ldquo;Yes — Ready to Buy&rdquo; email and click the
            button inside it to land back here with a fresh link.
          </p>
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

        {/* STEP 4 — SCORE REVEAL + PRIMARY PURCHASE CTA */}
        {step === 4 && result && (
          <section className="space-y-6 text-center">
            {result.qualified ? (
              <>
                <div className="text-6xl">⭐⭐⭐⭐⭐</div>
                <header>
                  <p className="text-xs uppercase tracking-widest text-saddle mb-2">You scored {result.score}/100</p>
                  <h1 className="font-serif text-4xl text-charcoal">You&apos;re qualified.</h1>
                  {result.routingOk && result.rancher ? (
                    <p className="text-saddle mt-3 text-base max-w-md mx-auto">
                      Matched with <strong className="text-charcoal">{result.rancher.name}</strong> in {result.rancher.state}.
                    </p>
                  ) : (
                    <p className="text-saddle mt-3 text-base max-w-md mx-auto">
                      We&apos;re holding your spot — the next rancher who opens up in your state gets you first.
                    </p>
                  )}
                </header>

                {/* Rancher trust card — pulled from Airtable live. Renders
                    photo + tagline + about + bona fides. Buyer sees WHO
                    they're about to pay before clicking the deposit button. */}
                {result.routingOk && result.rancher && (result.rancher.logoUrl || result.rancher.aboutText || result.rancher.tagline) && (
                  <div className="mt-8 border border-dust bg-white p-5 md:p-6 text-left">
                    <div className="flex items-start gap-4 flex-wrap">
                      {result.rancher.logoUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={result.rancher.logoUrl}
                          alt={result.rancher.name}
                          className="w-20 h-20 rounded-full object-cover border border-dust flex-shrink-0"
                        />
                      )}
                      <div className="flex-1 min-w-[200px]">
                        <p className="text-xs uppercase tracking-widest text-saddle mb-1">
                          Your matched rancher
                        </p>
                        <h2 className="font-serif text-2xl text-charcoal">
                          {result.rancher.name}
                        </h2>
                        {(result.rancher.city || result.rancher.state) && (
                          <p className="text-sm text-saddle">
                            {[result.rancher.city, result.rancher.state].filter(Boolean).join(', ')}
                          </p>
                        )}
                        {result.rancher.tagline && (
                          <p className="text-sm text-charcoal mt-2 italic">&ldquo;{result.rancher.tagline}&rdquo;</p>
                        )}
                      </div>
                    </div>
                    {result.rancher.aboutText && (
                      <p className="text-sm text-saddle mt-4 leading-relaxed line-clamp-3">
                        {result.rancher.aboutText}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2 mt-3">
                      {result.rancher.beefTypes && (
                        <span className="text-xs px-2 py-1 border border-dust bg-bone text-saddle">
                          {result.rancher.beefTypes}
                        </span>
                      )}
                      {result.rancher.certifications && (
                        <span className="text-xs px-2 py-1 border border-dust bg-bone text-saddle">
                          {result.rancher.certifications}
                        </span>
                      )}
                      {result.rancher.processingFacility && (
                        <span className="text-xs px-2 py-1 border border-dust bg-bone text-saddle">
                          USDA · {result.rancher.processingFacility}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* What you actually get — concrete cut breakdown */}
                {result.routingOk && (tier === 'Quarter' || tier === 'Half' || tier === 'Whole') && (
                  <div className="mt-4">
                    <CutBreakdown
                      tier={tier as CutTier}
                      totalCost={result.depositAmount ? result.depositAmount * 2 : undefined}
                    />
                  </div>
                )}

                {result.routingOk && result.rancher && (
                  <div className="grid gap-4 mt-6">
                    {/* Real scarcity badge — only shows if Next Processing
                        Date is set on the rancher record. No fake numbers. */}
                    {result.rancher.nextProcessingDate && (
                      <div className="bg-amber-50 border border-amber-300 px-4 py-2.5 text-sm text-amber-900 text-center">
                        🗓 Next processing date:{' '}
                        <strong>
                          {new Date(result.rancher.nextProcessingDate).toLocaleDateString(undefined, {
                            month: 'long',
                            day: 'numeric',
                            year: 'numeric',
                          })}
                        </strong>
                        {' '}— lock your slot before {result.rancher.name.split(' ')[0]}&apos;s schedule fills.
                      </div>
                    )}

                    {result.pricingModel === 'tier_v2' && result.depositAmount && result.referralId ? (
                      <>
                        {/* PRIMARY CTA — Reserve Now (tier_v2 buyer purchases on platform) */}
                        <button
                          onClick={() => choosePath('direct_deposit')}
                          disabled={!!pathChosen}
                          className="border-4 border-charcoal bg-charcoal text-bone hover:bg-saddle hover:border-saddle p-7 text-left transition-all disabled:opacity-50 shadow-lg"
                        >
                          <div className="flex items-start gap-4">
                            <div className="text-4xl">💳</div>
                            <div className="flex-1">
                              <p className="text-xs uppercase tracking-widest text-bone/70 mb-1">Recommended · Lock your slot</p>
                              <div className="font-serif text-2xl mb-2">Reserve your share — ${result.depositAmount} deposit</div>
                              <div className="text-sm text-bone/90 leading-relaxed">
                                Pay now → slot locked for the next processing run → {result.rancher.name} invoices the balance when ready for pickup.
                                <br />
                                <strong>No deposit, no slot held.</strong> Spots fill first-come.
                              </div>
                            </div>
                            <div className="font-medium text-2xl">→</div>
                          </div>
                        </button>

                        {/* SECONDARY — Talk first */}
                        <button
                          onClick={() => choosePath('rancher_meet')}
                          disabled={!!pathChosen}
                          className="border border-dust bg-white hover:bg-bone p-4 text-center transition-all disabled:opacity-50 text-sm text-saddle hover:text-charcoal"
                        >
                          Not sure yet? Schedule a 15-min call with {result.rancher.name} first →
                        </button>
                      </>
                    ) : (
                      /* Legacy rancher — schedule call only path */
                      <button
                        onClick={() => choosePath('rancher_meet')}
                        disabled={!!pathChosen}
                        className="border-4 border-charcoal bg-charcoal text-bone hover:bg-saddle hover:border-saddle p-7 text-left transition-all disabled:opacity-50 shadow-lg"
                      >
                        <div className="flex items-start gap-4">
                          <div className="text-4xl">📅</div>
                          <div className="flex-1">
                            <p className="text-xs uppercase tracking-widest text-bone/70 mb-1">Next step</p>
                            <div className="font-serif text-2xl mb-2">Meet {result.rancher.name}</div>
                            <div className="text-sm text-bone/90 leading-relaxed">
                              Schedule a 15-min call OR they&apos;ll reach out via email/phone within 24h with pricing, processing date, and how to lock in your order.
                            </div>
                          </div>
                          <div className="font-medium text-2xl">→</div>
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
