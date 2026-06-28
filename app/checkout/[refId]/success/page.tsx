'use client';

// Stage-3 Task 8 — post-deposit success page.

import { Suspense, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { trackEvent, metaEventId } from '@/lib/analytics';

interface Info {
  rancher: { name: string; ranchName: string; slug?: string };
}

// Pure: build the share deep-link a buyer sends to the neighbor they want to
// split the cow with. Points at the rancher's public page (where the neighbor
// can reserve their own share). Falls back to /access when the rancher slug is
// unknown so the link is never dead. We deliberately do NOT append a ?ref
// attribution param: the rancher page consumes no such param (the existing
// ?ref pipeline is for affiliate CODES on the homepage, not buyer referral
// IDs), so adding one promised tracking that never happened. Exported for
// unit testing.
export function buildShareLink(slug: string | undefined, _refId: string, origin = ''): string {
  const base = origin.replace(/\/+$/, '');
  const path = slug
    ? `/ranchers/${encodeURIComponent(slug)}`
    : '/access';
  return `${base}${path}`;
}

export default function DepositSuccessPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bg text-text-primary flex items-center justify-center"><p>Loading…</p></div>}>
      <DepositSuccessContent />
    </Suspense>
  );
}

function DepositSuccessContent() {
  const params = useParams<{ refId: string }>();
  const search = useSearchParams();
  const refId = params.refId;
  const sessionId = search.get('session_id') || '';

  const [info, setInfo] = useState<Info | null>(null);
  const [copied, setCopied] = useState(false);

  // G4 — deposit_completed client Pixel fire on success landing.
  // Server-side CAPI InitiateCheckout fires from the buyer_deposit branch of
  // app/api/webhooks/stripe/route.ts (payment_intent.succeeded). Both deposit
  // events are InitiateCheckout; the real Purchase fires at Closed Won
  // (final_invoice branch). Server uses event_id=referralId — match here.
  // Idempotency guard prevents re-fire on remount/back-button.
  const depositCompletedFired = useRef(false);
  useEffect(() => {
    if (depositCompletedFired.current || !refId) return;
    depositCompletedFired.current = true;
    trackEvent('deposit_completed', {
      refId,
      sessionId: sessionId || '',
      event_id: metaEventId(refId),
    });
  }, [refId, sessionId]);

  useEffect(() => {
    fetch(`/api/checkout/deposit?refId=${encodeURIComponent(refId)}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (!j) return;
        // Happy path: the GET returns full rancher info (name/ranchName/slug).
        if (!j.error) { setInfo(j); return; }
        // Already-paid path: by the time the buyer lands here the referral has
        // flipped to a paid/closed status, so the GET returns a 409 with
        // `error: 'referral_closed'`. That branch now carries the rancher slug
        // so the refer-a-friend link can still build a real /ranchers/<slug>
        // deep-link instead of falling back to /access. name/ranchName aren't
        // included there, so they keep their friendly "your rancher" defaults.
        if (j.error === 'referral_closed' && j.rancher?.slug) {
          setInfo({ rancher: { name: '', ranchName: '', slug: j.rancher.slug } });
        }
      })
      .catch(() => {});
  }, [refId]);

  const rancherName = info?.rancher?.name || 'your rancher';
  // First name for friendly inline mentions. Special-case the "your rancher"
  // default so a missing name reads "your rancher" (not "your"), which would
  // otherwise produce "Tell your how you want it".
  const rancherFirst = rancherName === 'your rancher' ? 'your rancher' : rancherName.split(' ')[0];

  // Refer-a-friend ("split your cow with a neighbor"). The share link points at
  // the rancher's public page and is attributed back to this buyer via ?ref.
  // origin is only known client-side, so compute it lazily.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const shareLink = buildShareLink(info?.rancher?.slug, refId, origin);
  const ranchLabel = info?.rancher?.ranchName || rancherName;
  const shareMessage =
    `I just reserved a share of beef from ${ranchLabel} on BuyHalfCow — want to split a cow? Grab your half here: ${shareLink}`;
  const smsHref = `sms:?&body=${encodeURIComponent(shareMessage)}`;
  const emailHref =
    `mailto:?subject=${encodeURIComponent('Want to split a cow?')}&body=${encodeURIComponent(shareMessage)}`;

  const copyShareLink = async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* clipboard blocked — the link is still visible/selectable in the field */
    }
  };

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="max-w-2xl mx-auto px-4 md:px-6 py-8 md:py-12">
        <h1 className="font-serif text-3xl md:text-4xl mb-2">
          Deposit confirmed.
        </h1>
        <p className="text-saddle mb-6 md:mb-8 text-base md:text-lg">
          Your payment to <strong>{rancherName}</strong> went through. A receipt is in your email.
        </p>

        {/* Primary handoff CTA — the buyer's one action right now. Tell the
            rancher how they want it so the first call is productive. */}
        <div className="bg-white border-2 border-charcoal p-4 md:p-6 mb-6">
          <h2 className="font-serif text-lg md:text-xl mb-2">Tell {rancherFirst} how you want it</h2>
          <p className="text-sm md:text-base text-charcoal mb-4">
            Delivery or pickup, when you&rsquo;d like it, and anything for the cut sheet. 30 seconds &mdash; and {rancherFirst} has it before they call you.
          </p>
          <Link
            href={`/checkout/${refId}/preferences`}
            className="inline-flex items-center justify-center bg-charcoal text-bone px-6 py-3 min-h-[48px] uppercase tracking-wider text-sm hover:bg-saddle transition"
          >
            Set your preferences &rarr;
          </Link>
        </div>

        {/* What's next — honest, day-by-day. No tracking promise; rancher
            coordinates directly. The "today" line is now TRUE: deposit
            settlement notifies the rancher by email + text (lib/rancherNotify). */}
        <div className="bg-white border border-dust p-4 md:p-6 mb-6">
          <h2 className="font-serif text-lg md:text-xl mb-4">What happens next</h2>
          <ol className="space-y-4 text-sm md:text-base text-charcoal">
            <li className="flex gap-3">
              <span className="text-saddle font-medium flex-shrink-0">Today:</span>
              <span>We let {rancherName} know your deposit landed &mdash; by email and text. They reach out directly to set things up, usually the same day.</span>
            </li>
            <li className="flex gap-3">
              <span className="text-saddle font-medium flex-shrink-0">This week:</span>
              <span>You and {rancherName} settle pickup or delivery details in your message thread &mdash; date, exact location, balance due at pickup.</span>
            </li>
            <li className="flex gap-3">
              <span className="text-saddle font-medium flex-shrink-0">When ready:</span>
              <span>You pick up or {rancherName} delivers. {rancherName} confirms fulfillment and gets paid out by Stripe.</span>
            </li>
          </ol>
        </div>

        {/* Refer-a-friend — the core "split half a cow with a neighbor" use case.
            A buyer who just reserved is the best moment to ask them to bring the
            other half. Pre-filled deep-link attributed back via ?ref. */}
        <div className="bg-white border-2 border-saddle p-4 md:p-6 mb-6">
          <h2 className="font-serif text-lg md:text-xl mb-2">Split your cow &mdash; invite your other half</h2>
          <p className="text-sm md:text-base text-charcoal mb-4">
            A whole or half cow is a lot of beef. Send a neighbor, friend, or family member your link &mdash; they reserve their share from {rancherFirst}, and you split the haul.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 mb-3">
            <input
              type="text"
              readOnly
              value={shareLink}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Your share link"
              className="flex-1 min-w-0 border border-dust bg-bone px-3 py-2.5 text-sm text-charcoal font-mono truncate"
            />
            <button
              type="button"
              onClick={copyShareLink}
              className="flex-shrink-0 bg-charcoal text-bone px-5 py-2.5 min-h-[44px] uppercase tracking-wider text-sm hover:bg-saddle transition"
            >
              {copied ? 'Copied!' : 'Copy link'}
            </button>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <a
              href={smsHref}
              className="flex-1 text-center bg-bone border border-charcoal text-charcoal px-5 py-2.5 min-h-[44px] flex items-center justify-center uppercase tracking-wider text-sm hover:bg-divider hover:text-bone transition"
            >
              Share by text
            </a>
            <a
              href={emailHref}
              className="flex-1 text-center bg-bone border border-charcoal text-charcoal px-5 py-2.5 min-h-[44px] flex items-center justify-center uppercase tracking-wider text-sm hover:bg-divider hover:text-bone transition"
            >
              Share by email
            </a>
          </div>
        </div>

        {/* BHC Promise reminder — paid-ad buyers landing here for the first time
            need the reassurance reinforced. */}
        <div className="border-l-4 border-sage-dark bg-white p-4 md:p-5 mb-6 md:mb-8">
          <p className="text-sm text-charcoal leading-relaxed">
            <strong>BHC Promise still applies.</strong> If anything goes sideways &mdash; cold-chain failure, the beef isn&apos;t what you expected, anything &mdash; reply to your message thread or email <a href="mailto:hello@buyhalfcow.com" className="underline">hello@buyhalfcow.com</a> within 7 days of receipt. We refund the deposit.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <Link
            href={`/checkout/${refId}/ask`}
            className="flex-1 text-center bg-charcoal text-bone px-6 py-3 min-h-[48px] flex items-center justify-center uppercase tracking-wider text-sm hover:bg-saddle transition"
          >
            Open thread with {rancherFirst} &rarr;
          </Link>
          <Link
            href="/member"
            className="flex-1 text-center bg-bone border border-charcoal text-charcoal px-6 py-3 min-h-[48px] flex items-center justify-center uppercase tracking-wider text-sm hover:bg-divider hover:text-bone transition"
          >
            Your dashboard
          </Link>
        </div>

        <div className="mt-8 pt-6 border-t border-divider text-center text-saddle text-sm">
          <p>Questions? Reply to the receipt email or message {rancherName} directly.</p>
          {sessionId && (
            <p className="text-xs text-dust mt-3 font-mono break-all">
              ref: {sessionId.slice(0, 24)}&hellip;
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
