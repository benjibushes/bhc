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
    <Suspense fallback={<div className="min-h-screen bg-bone text-charcoal flex items-center justify-center"><p>Loading…</p></div>}>
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
  // A6 — only claim "confirmed" once payment is actually verified. The paid
  // signal is the referral flipping closed (GET returns referral_closed). Until
  // then (webhook lag, or a direct/bookmarked/back-button hit) we say
  // "confirming…" instead of a false "Deposit confirmed."
  const [paidConfirmed, setPaidConfirmed] = useState(false);
  // U2 — once polling exhausts (webhook lag > ~15s) or errors, STOP claiming
  // "confirming…" forever. Flip to a terminal reassurance state (the Stripe
  // return means the charge already succeeded) with a manual "Check again".
  const [pollDone, setPollDone] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

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
    let alive = true;
    let tries = 0;
    // ~15s of webhook grace (6 × 2.5s) before we settle into the terminal
    // reassurance state. Deposit settlement is usually a few seconds; this
    // gives Airtable + the Connect webhook comfortable headroom.
    const MAX_TRIES = 6;
    const poll = () => {
      fetch(`/api/checkout/deposit?refId=${encodeURIComponent(refId)}`, { credentials: 'include' })
        .then((r) => r.json())
        .then((j) => {
          if (!alive || !j) return;
          // Happy path GET returns full rancher info — but a NON-error response
          // means the referral is still OPEN (not yet paid). That's either a
          // pre-payment direct/bookmark hit OR webhook lag right after paying.
          if (!j.error) {
            setInfo(j);
            // Only poll for the paid flip when we actually came from Stripe
            // (session_id present) — otherwise this is just an unpaid visit,
            // so go straight to terminal (don't hang on "confirming…").
            if (sessionId && tries < MAX_TRIES) { tries++; setTimeout(poll, 2500); }
            else if (alive) setPollDone(true);
            return;
          }
          // referral_closed = PAID. This is the real "confirmed" signal.
          if (j.error === 'referral_closed') {
            setPaidConfirmed(true);
            setPollDone(true);
            if (j.rancher?.slug && !info) {
              setInfo({ rancher: { name: '', ranchName: '', slug: j.rancher.slug } });
            }
            return;
          }
          // Any other error (load_failed, not-found, auth) — stop polling and
          // fall into the terminal state rather than an eternal "confirming…".
          if (alive) setPollDone(true);
        })
        .catch(() => { if (alive) setPollDone(true); });
    };
    setPollDone(false);
    poll();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refId, sessionId, refreshNonce]);

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
          {paidConfirmed
            ? 'you reserved your beef.'
            : pollDone
              ? 'your deposit is in.'
              : 'confirming your payment…'}
        </h1>
        <p className="text-saddle mb-4 text-base md:text-lg">
          {paidConfirmed
            ? <>your spot with <strong>{rancherName}</strong> is locked in — a receipt&apos;s in your inbox.</>
            : pollDone
              ? <>your payment went through — we&apos;re just finalizing the details, and your receipt is on its way to your inbox. everything below is ready for you now.</>
              : <>hang tight a moment while we confirm your payment. this can take a few seconds — your receipt will land in your email.</>}
        </p>
        {/* U2 — never a dead "confirming…". When the webhook is still catching
            up, offer a manual re-check instead of an infinite spinner headline. */}
        {!paidConfirmed && pollDone && (
          <button
            type="button"
            onClick={() => setRefreshNonce((n) => n + 1)}
            className="mb-6 md:mb-8 inline-flex items-center text-sm text-saddle underline underline-offset-2 hover:text-charcoal"
          >
            Check payment status again
          </button>
        )}
        {!pollDone && <div className="mb-6 md:mb-8" />}

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
            <strong>BHC Promise still applies.</strong> Your deposit is fully refundable until {rancherFirst} accepts your slot &mdash; usually within 24&ndash;48 hours. Once they commit your processing slot it&apos;s non-refundable, but the cold-chain guarantee never goes away: if your beef arrives thawed or short, BHC makes you whole. Anything goes sideways &mdash; reply to your message thread or <Link href={`/support?ref=${encodeURIComponent(refId)}`} className="underline">get help here</Link> and we step in, or email <a href="mailto:hello@buyhalfcow.com" className="underline">hello@buyhalfcow.com</a>.
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
          {/* Discoverability — the deposit created (or matched) a real account.
              Say so explicitly: buyers who close this tab need to know status,
              tracking, and the rancher thread live at /member forever. */}
          <p className="mb-3">
            You have a BuyHalfCow account &mdash; order status, tracking, and your
            message thread live at{' '}
            <Link href="/member" className="underline hover:text-charcoal">
              buyhalfcow.com/member
            </Link>
            . Signed out later? We&apos;ll email you a sign-in link &mdash; no password needed.
          </p>
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
