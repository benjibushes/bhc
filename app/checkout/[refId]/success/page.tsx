'use client';

// Stage-3 Task 8 — post-deposit success page.

import { Suspense, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { trackEvent, metaEventId } from '@/lib/analytics';
import { track } from '@/lib/track';
import GearBlock from '@/app/components/GearBlock';
import { cutForBuyer } from '@/lib/demandRouter';
import {
  depositNextSteps,
  type DepositRail,
  type RancherSheetDelivery,
} from '@/lib/depositSuccessCopy';

// Client-safe mirror of lib/metaCapi depositEventId (that module imports node
// `crypto`, so it must not be pulled into this 'use client' bundle). The server
// deposit Purchase (settleBuyerDeposit) fires with this EXACT id — keep in sync.
const depositEventId = (refId: string) => `deposit_${refId}`;

interface Info {
  rancher: { name: string; ranchName: string; slug?: string };
}

// Pure: build the share deep-link a buyer sends to the neighbor they want to
// split the cow with. Points at the rancher's public page (where the neighbor
// can reserve their own share). Falls back to /access when the rancher slug is
// unknown so the link is never dead.
//
// T2.2 (2026-07-02): appends ?ref=<the buyer's affiliate code> when known.
// This attribution is REAL now — both destinations consume ?ref (the rancher
// page threads it through DepositReserveForm into /api/checkout/reserve, and
// /access feeds it to /api/consumers), server-validated, and the referrer is
// credited at Closed Won via creditAffiliateOnClose. Historically this link
// carried no ref because nothing consumed it; that gap is closed. No code →
// plain link (an untracked share beats a dead promise). Exported for unit
// testing.
export function buildShareLink(
  slug: string | undefined,
  _refId: string,
  origin = '',
  refCode = '',
): string {
  const base = origin.replace(/\/+$/, '');
  const path = slug
    ? `/ranchers/${encodeURIComponent(slug)}`
    : '/access';
  const ref = refCode ? `?ref=${encodeURIComponent(refCode)}` : '';
  return `${base}${path}${ref}`;
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
  // T2.2 — the buyer's own affiliate code, surfaced by the paid-branch 409.
  const [affiliateCode, setAffiliateCode] = useState('');
  // Buyer's share size (raw Order Type), surfaced by the referral_closed 409 —
  // feeds the affiliate GearBlock's cut selection (whole → freezer-first gear).
  const [orderType, setOrderType] = useState('');
  // Attribution (2026-07-28): the authed buyer's record id, surfaced by the
  // referral_closed 409 — threads into the GearBlock's /go/product?buyer=
  // click log (was hardcoded '' → 118 gear clicks, 0 attributed).
  const [buyerRecordId, setBuyerRecordId] = useState('');
  // A6 — only claim "confirmed" once payment is actually verified. The paid
  // signal is the referral flipping closed (GET returns referral_closed). Until
  // then (webhook lag, or a direct/bookmarked/back-button hit) we say
  // "confirming…" instead of a false "Deposit confirmed."
  const [paidConfirmed, setPaidConfirmed] = useState(false);
  // Buyer-paid deposit total (dollars), surfaced by the referral_closed 409 —
  // the value for the client Purchase Pixel below (matches the server CAPI
  // deposit Purchase value exactly, both = pi.amount).
  const [depositValue, setDepositValue] = useState(0);
  // U2 — once polling exhausts (webhook lag > ~15s) or errors, STOP claiming
  // "confirming…" forever. Flip to a terminal reassurance state (the Stripe
  // return means the charge already succeeded) with a manual "Check again".
  const [pollDone, setPollDone] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // RAIL (2026-08-17). This page is the success_url of BOTH deposit rails, and
  // everything it said about "what happens next" was Connect machinery: we
  // notified the rancher, you settle in your message thread, they get paid out
  // by Stripe. A BROKER buyer's ranch is REPRESENTED — no login, no dashboard,
  // no thread, no Connect account — and pays nothing out through us: the buyer
  // settles the balance with the ranch directly. Default 'connect' so any
  // read failure lands on the copy that shipped. See lib/depositSuccessCopy.
  const [rail, setRail] = useState<DepositRail>('connect');
  // Broker only — whether the ranch was actually sent the fulfillment sheet.
  // The page claims "we told them" ONLY on a recorded delivery.
  const [rancherNotified, setRancherNotified] = useState<RancherSheetDelivery>('unknown');

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

  // DEPOSIT-LEVEL META CONVERSION (2026-07-04) — client Purchase Pixel.
  // Fires the browser-side Meta Purchase ONLY once the deposit is CONFIRMED PAID
  // (paidConfirmed = the referral_closed GET landed), with the SAME event_id the
  // server CAPI deposit Purchase uses (deposit_<refId>) so browser + server dedup
  // into ONE Purchase.
  //
  // DARK BY DEFAULT — three gates, all must pass:
  //   1. NEXT_PUBLIC_META_PIXEL_ID present (else PixelTracker never loads fbq and
  //      track() no-ops anyway — this is the belt).
  //   2. NEXT_PUBLIC_META_DEPOSIT_PURCHASE_ENABLED === 'true' — the client mirror
  //      of the server META_DEPOSIT_PURCHASE_ENABLED flag, so browser + server
  //      turn on TOGETHER (a lone client Purchase with no server pair, or vice
  //      versa, never happens). Off = byte-identical (no Purchase fires here).
  //   3. paidConfirmed — a Purchase must NEVER fire without a verified paid
  //      deposit (unlike the InitiateCheckout above, an intent signal safe on
  //      landing). No fire on an unconfirmed/direct/back-button hit.
  // Idempotency ref prevents a re-fire on poll re-render / remount.
  //
  // BOTH DEPOSIT RAILS LAND HERE (verified 2026-08-17). The broker checkout's
  // success_url is this same page (app/api/checkout/broker/route.ts:211), and
  // every link in the chain already holds for a broker referral:
  //   • auth — resolveDepositAuth accepts the referral-scoped deposit grant the
  //     broker rail issues, not just a member session;
  //   • paidConfirmed — settleBrokerDeposit stamps 'Deposit Paid At', so the
  //     poll's GET hits the same referral_closed 409 (the terminal-status gate
  //     is upstream of the Connect-only rail gate, so a broker row never trips it);
  //   • depositValue — read from the settled Payments row's 'Total Charged
  //     Cents', which markDepositSucceeded writes as the deposit on the broker
  //     rail. That is exactly what the buyer's card was charged there (the
  //     balance is paid to the ranch off-platform), and it matches the value the
  //     server fires from lib/brokerCapi;
  //   • event_id — deposit_<refId> on both rails, so browser + server dedup.
  // Nothing rail-specific belongs in this effect; keep it that way.
  const depositPurchaseFired = useRef(false);
  useEffect(() => {
    if (depositPurchaseFired.current || !refId || !paidConfirmed) return;
    const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
    const flagOn = process.env.NEXT_PUBLIC_META_DEPOSIT_PURCHASE_ENABLED === 'true';
    if (!pixelId || !flagOn) return;
    depositPurchaseFired.current = true;
    track('Purchase', {
      value: depositValue,
      currency: 'USD',
      content_category: 'buyer-deposit',
      event_id: depositEventId(refId),
    });
  }, [refId, paidConfirmed, depositValue]);

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
            // The rail decides the whole "what happens next" story below, and
            // the delivery verdict decides whether we may claim we told the
            // ranch. Both ride this 409 (the deposit GET already reads the
            // rancher record on this branch).
            if (j.rail === 'broker') setRail('broker');
            if (j.rancherNotified) setRancherNotified(j.rancherNotified as RancherSheetDelivery);
            if ((j.rancher?.slug || j.rancher?.name || j.rancher?.ranchName) && !info) {
              setInfo({
                rancher: {
                  name: String(j.rancher?.name || ''),
                  ranchName: String(j.rancher?.ranchName || ''),
                  slug: j.rancher?.slug || undefined,
                },
              });
            }
            // T2.2: the buyer's own share code (minted silently at settle) —
            // upgrades the share link below from untracked to attributed.
            if (j.affiliateCode) setAffiliateCode(String(j.affiliateCode));
            // Order Type → drives the affiliate GearBlock's cut selection.
            if (j.orderType) setOrderType(String(j.orderType));
            // Buyer record id → GearBlock click attribution.
            if (j.buyerId) setBuyerRecordId(String(j.buyerId));
            // Buyer-paid total for the client Purchase Pixel (fired below once
            // paid is confirmed). 0 when unreadable — the Pixel still fires,
            // matching the server (value defaults to 0 there too under the same
            // read failure), so dedup by (event_name, event_id) is unaffected.
            if (typeof j.depositValue === 'number') setDepositValue(j.depositValue);
            return;
          }
          // BROKER, NOT YET SETTLED. The deposit GET is the Connect endpoint,
          // so a broker referral gets this rail 409 until settleBrokerDeposit
          // stamps Deposit Paid At and the referral_closed branch above takes
          // over. Treat it exactly like the open-referral case: adopt the rail
          // + ranch name so the copy below is broker-correct during the wait,
          // and keep polling for the settle stamp instead of dropping straight
          // into the terminal state (which used to leave a broker buyer on
          // "your deposit is in" with a manual re-check button as the only way
          // forward).
          if (j.error === 'not_connect_rail' && j.rail === 'broker') {
            setRail('broker');
            if (j.rancher && !info) {
              setInfo({
                rancher: {
                  name: String(j.rancher.name || ''),
                  ranchName: String(j.rancher.ranchName || ''),
                  slug: j.rancher.slug || undefined,
                },
              });
            }
            if (sessionId && tries < MAX_TRIES) { tries++; setTimeout(poll, 2500); }
            else if (alive) setPollDone(true);
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

  const isBroker = rail === 'broker';
  const rancherName = info?.rancher?.name || 'your rancher';
  // First name for friendly inline mentions. Special-case the "your rancher"
  // default so a missing name reads "your rancher" (not "your"), which would
  // otherwise produce "Tell your how you want it".
  const rancherFirst = rancherName === 'your rancher' ? 'your rancher' : rancherName.split(' ')[0];

  // Refer-a-friend ("split your cow with a neighbor"). The share link points at
  // the rancher's public page and is attributed back to this buyer via ?ref.
  // origin is only known client-side, so compute it lazily.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const shareLink = buildShareLink(info?.rancher?.slug, refId, origin, affiliateCode);
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

        {/* What's next — honest, day-by-day, and RAIL-AWARE (2026-08-17). The
            words live in lib/depositSuccessCopy so both rails' stories are unit
            tested: the Connect list is unchanged, and the broker list drops the
            thread / accept / Stripe-payout machinery a represented ranch does
            not have. On the broker rail the "we told the ranch" line is earned
            by a recorded delivery, not assumed. */}
        <div className="bg-white border border-dust p-4 md:p-6 mb-6">
          <h2 className="font-serif text-lg md:text-xl mb-4">What happens next</h2>
          <ol className="space-y-4 text-sm md:text-base text-charcoal">
            {depositNextSteps({
              rail,
              rancherLabel: rancherName,
              sheetDelivery: rancherNotified,
            }).map((step) => (
              <li key={step.when} className="flex gap-3">
                <span className="text-saddle font-medium flex-shrink-0">{step.when}</span>
                <span>{step.text}</span>
              </li>
            ))}
          </ol>
        </div>

        {/* Refer-a-friend — the core "split half a cow with a neighbor" use case.
            A buyer who just reserved is the best moment to ask them to bring the
            other half. Pre-filled deep-link attributed back via ?ref. */}
        <div className="bg-white border-2 border-saddle p-4 md:p-6 mb-6">
          <h2 className="font-serif text-lg md:text-xl mb-2">Split your cow &mdash; invite your other half</h2>
          <p className="text-sm md:text-base text-charcoal mb-4">
            A whole or half cow is a lot of beef. Send a neighbor, friend, or family member your link &mdash; they reserve their share from {rancherFirst}, and you split the haul.
            {affiliateCode ? ' This link is yours — when someone orders through it, you earn a referral credit.' : ''}
          </p>
          <div className="flex flex-col sm:flex-row gap-2 mb-3">
            <input
              type="text"
              readOnly
              value={shareLink}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Your share link"
              className="flex-1 min-w-0 border border-dust bg-bone px-3 py-2.5 text-base text-charcoal font-mono truncate"
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

        {/* Affiliate gear — "while you wait, here's what you'll want". A buyer
            who just reserved (share not yet delivered) is the moment to surface
            the freezer/sealer/knives they'll need. cutForBuyer maps Order Type
            → cut so a whole-cow buyer sees a chest freezer pinned first. The
            block renders NOTHING when the catalog is empty (today's reality),
            so this is invisible until Ben activates products. */}
        <div className="mb-6">
          <GearBlock
            stage="waiting"
            cut={cutForBuyer({ 'Order Type': orderType })}
            buyerId={buyerRecordId}
            refId={refId}
            surface="success"
          />
        </div>

        {/* BHC Promise reminder — paid-ad buyers landing here for the first time
            need the reassurance reinforced. RAIL-AWARE for the same reason as
            BHCPromiseBadge's two variants: the Connect promise is keyed to the
            rancher tapping Accept in a dashboard, which on the broker rail is
            machinery that does not exist. The broker wording mirrors the
            checkout page's promise and the buyer receipt exactly — refundable
            until the ranch confirms the animal, refunded by BuyHalfCow. */}
        <div className="border-l-4 border-sage-dark bg-white p-4 md:p-5 mb-6 md:mb-8">
          <p className="text-sm text-charcoal leading-relaxed">
            <strong>BHC Promise still applies.</strong>{' '}
            {isBroker ? (
              <>
                Your deposit is fully refundable until {ranchLabel} confirms your animal &mdash; email <a href="mailto:hello@buyhalfcow.com" className="underline">hello@buyhalfcow.com</a> and BuyHalfCow refunds it in full. Once they confirm it&apos;s non-refundable, but the cold-chain guarantee never goes away: if your beef arrives thawed or short, BHC makes you whole. Anything goes sideways &mdash; <Link href={`/support?ref=${encodeURIComponent(refId)}`} className="underline">get help here</Link> and we step in.
              </>
            ) : (
              <>
                Your deposit is fully refundable until {rancherFirst} accepts your slot &mdash; usually within 24&ndash;48 hours. Once they commit your processing slot it&apos;s non-refundable, but the cold-chain guarantee never goes away: if your beef arrives thawed or short, BHC makes you whole. Anything goes sideways &mdash; reply to your message thread or <Link href={`/support?ref=${encodeURIComponent(refId)}`} className="underline">get help here</Link> and we step in, or email <a href="mailto:hello@buyhalfcow.com" className="underline">hello@buyhalfcow.com</a>.
              </>
            )}
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <Link
            href={`/checkout/${refId}/ask`}
            className="flex-1 text-center bg-charcoal text-bone px-6 py-3 min-h-[48px] flex items-center justify-center uppercase tracking-wider text-sm hover:bg-saddle transition"
          >
            {/* "Open thread" is Connect framing — a represented ranch has no
                login and never sees a thread UI. The link still works on both
                rails (every message is mirrored to the other side's email with
                a routed Reply-To), so the broker label describes what actually
                happens: a message reaches them. */}
            {isBroker ? 'Message ' : 'Open thread with '}{rancherFirst} &rarr;
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
          {/* The broker receipt carries the ranch's own phone + email ("You can
              reach them directly"), so point there rather than implying a
              platform channel to a ranch that lives outside the platform. */}
          <p>
            {isBroker
              ? `Questions? Reply to your receipt email — it has ${ranchLabel}'s own phone and email on it.`
              : `Questions? Reply to the receipt email or message ${rancherName} directly.`}
          </p>
          {sessionId && (
            <p className="text-xs text-muted mt-3 font-mono break-all">
              ref: {sessionId.slice(0, 24)}&hellip;
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
