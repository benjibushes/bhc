'use client';

// Step 9 — Stripe Connect, told honestly.
//
// WHAT THIS STEP USED TO BE: 139 lines, one button, zero knowledge of the
// rancher in front of it. "Never started", "mid-KYC with 3 things due" and
// "Stripe has restricted this account" all rendered the identical
// `Connect bank account →` — so a rancher who had already handed Stripe their
// bank details was told to start over, and a rancher Stripe had HELD was sent
// back into an onboarding loop that could never clear the hold.
//
// The number that made this the company's #1 constraint: 12 ranchers started
// Stripe Connect, 6 finished. Five of the six stalled at Stripe screen ONE
// (tos_acceptance.date: null) — they never even reached the bank/SSN pages.
//
// WHAT IT IS NOW: it reads the live status on mount (#480's
// /api/rancher/connect/status, which returns a structured
// never_started | incomplete | restricted | active plus the REAL currentlyDue
// list) and renders exactly ONE next action for the state the rancher is
// actually in. Plus an "I finished — re-check" button, because ranchers finish
// on Stripe and come back before the account.updated webhook lands.
//
// The rancher DASHBOARD (app/rancher/page.tsx, DashboardBannerCascade) already
// solved this cascade well. This mirrors its logic and its routing — same
// endpoints, same restricted→portal fallback, same self-serve re-check — so a
// rancher sees one product, not two dialects of one.
//
// Connect is REQUIRED and there is no skip. A tier_v2 rancher who skipped used
// to go live with Connect 'onboarding' and every buyer deposit 409'd at
// checkout. A rancher who isn't ready can close the tab and resume exactly here
// later (the setup token preserves progress); their page never publishes until
// Connect is verified.
//
// Legacy (non-tier_v2) ranchers auto-advance on mount — they're paid through
// their own payment links and never touch Connect.

import { useCallback, useEffect, useState } from 'react';
import {
  connectStateFrom,
  humanizeRequirements,
  type ConnectHandoffState,
} from '@/lib/connectStepDecision';

interface Props {
  rancherId: string;
  pricingModel: 'legacy' | 'tier_v2' | string;
  wizardToken?: string;
  /**
   * Airtable's cached `Stripe Connect Status` from the wizard's own payload.
   * Used ONLY as a first paint / last-resort fallback when the live read is in
   * flight or fails — never in place of it. (The cache is webhook-written and
   * is exactly what goes stale on the ranchers this step exists for.)
   */
  cachedConnectStatus?: string;
  /**
   * Called ONLY when this step is genuinely finished — i.e. Stripe reports
   * `active`, or the rancher is legacy and never needed Connect at all. It
   * hands back the state it observed so the wizard branches on what was
   * actually read here, not on an assumption made at the call site.
   */
  onComplete: (observedState?: ConnectHandoffState | null) => void;
  onBack?: () => void;
}

type Phase = 'loading' | 'loaded' | 'read_failed';

/** Loosely-typed JSON body — every field is read defensively at the use site. */
type Payload = Record<string, unknown>;

export default function StripeConnectStep({
  rancherId,
  pricingModel,
  wizardToken,
  cachedConnectStatus,
  onComplete,
  onBack,
}: Props) {
  const isTierV2 = pricingModel === 'tier_v2';

  // The cached Airtable status may only ever produce a NON-advancing state.
  // A stale 'active' (the webhook wrote it, then Stripe re-opened a
  // requirement) would otherwise paint a Continue button that walks a
  // not-actually-active rancher to Sign — precisely the loop this closes.
  // 'active' is a LIVE-read-only conclusion. Everything else is safe as a
  // first paint, and beats a blank while the read is in flight.
  const cached = connectStateFrom(cachedConnectStatus);
  const safeCached = cached === 'active' ? null : cached;

  const [phase, setPhase] = useState<Phase>('loading');
  const [state, setState] = useState<ConnectHandoffState | null>(safeCached);
  /** True once a LIVE Stripe read produced `state` (as opposed to the cache). */
  const [fromLive, setFromLive] = useState(false);
  /** Plain-English version of Stripe's real currently_due list. */
  const [due, setDue] = useState<string[]>([]);
  const [dueCount, setDueCount] = useState(0);
  const [busy, setBusy] = useState<'' | 'start' | 'recheck' | 'portal'>('');
  const [error, setError] = useState('');
  const [recheckMsg, setRecheckMsg] = useState('');

  // ── Live status read ─────────────────────────────────────────────────────
  // GET /api/rancher/connect/status rides the `bhc-rancher-auth` cookie that
  // GET /api/rancher/setup minted when the wizard loaded. That mint is
  // best-effort (it can fail on a headers-already-sent edge), so a 401 here is
  // possible and MUST NOT dead-end: we fall through to 'read_failed', which
  // renders the start/resume action anyway — POST /connect/start authenticates
  // off the wizardToken and works with no cookie at all.
  const loadStatus = useCallback(async (): Promise<ConnectHandoffState | null> => {
    try {
      const res = await fetch('/api/rancher/connect/status', { credentials: 'include' });
      const data: Payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPhase('read_failed');
        return null;
      }
      // `state` is #480's structured truth; `status` is the older field on the
      // same payload. Cache is the last resort, and only when both are unread.
      const resolved =
        connectStateFrom(data?.state) ?? connectStateFrom(data?.status) ?? safeCached;
      if (!resolved) {
        setPhase('read_failed');
        return null;
      }
      const codes = Array.isArray(data?.currentlyDue) ? data.currentlyDue : [];
      const count = Number(data?.currentlyDueCount);
      setDue(humanizeRequirements(codes));
      setDueCount(Number.isFinite(count) && count > 0 ? count : codes.length);
      setState(resolved);
      setFromLive(true);
      setPhase('loaded');
      return resolved;
    } catch {
      setPhase('read_failed');
      return null;
    }
  }, [safeCached]);

  useEffect(() => {
    // Legacy ranchers skip this step entirely — auto-advance on mount. Use an
    // effect so the parent wizard's setState doesn't fire during render.
    if (!isTierV2) {
      onComplete(null);
      return;
    }
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTierV2]);

  // ── Actions ──────────────────────────────────────────────────────────────

  // Start OR resume — the same endpoint does both (it creates the account when
  // there isn't one, and always mints a FRESH account link, so a rancher who
  // abandoned mid-KYC lands straight back on the next required Stripe screen).
  //
  // DELIBERATELY NOT the `resumeUrl` on the status payload: that link is minted
  // with returnUrl=/rancher/billing, which would dump a mid-wizard rancher onto
  // the billing dashboard and skip Sign entirely. from='wizard' + wizardToken
  // is what brings them back here with ?connectComplete=1.
  const goToStripe = async () => {
    setBusy('start');
    setError('');
    setRecheckMsg('');
    try {
      const res = await fetch('/api/rancher/connect/start', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rancherId, from: 'wizard', wizardToken }),
      });
      const data: Payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data.error || `Connect failed (${res.status})`));
      const target = String(data.url || data.resumeUrl || data.onboardingUrl || '');
      if (!target) throw new Error('No onboarding URL returned');
      window.location.href = target;
    } catch (e) {
      setError((e instanceof Error && e.message) || 'Failed to open Stripe payout setup.');
      setBusy('');
    }
  };

  // Restricted accounts only. Mirrors the dashboard's openBillingPortal: the
  // portal session is created against the CONNECT account, so it's where a
  // rancher sees Stripe's own detail on the hold. New tab, so the wizard (and
  // their progress) survives.
  const openStripePortal = async () => {
    setBusy('portal');
    setError('');
    try {
      const res = await fetch('/api/rancher/tier/portal', { credentials: 'include' });
      const data: Payload = await res.json().catch(() => ({}));
      if (res.ok && data.url) window.open(String(data.url), '_blank', 'noopener,noreferrer');
      else setError(String(data.error || 'Could not open your Stripe account just now.'));
    } catch {
      setError('Network error — try again in a moment.');
    } finally {
      setBusy('');
    }
  };

  // "I finished — re-check". Ranchers finish on Stripe and come straight back;
  // the cached status only flips to active when the account.updated webhook
  // arrives, and when that fires early (pre-merge dup race) or never, they are
  // stuck here forever. POST does the authoritative LIVE read and persists the
  // true status to their own record — the same self-serve unstick the dashboard
  // offers. Then we re-read so the due list on screen is current too.
  const recheck = async () => {
    setBusy('recheck');
    setError('');
    setRecheckMsg('');
    try {
      const res = await fetch('/api/rancher/connect/status', {
        method: 'POST',
        credentials: 'include',
      });
      const data: Payload = await res.json().catch(() => ({}));
      const resolved = await loadStatus();
      if (!res.ok) {
        // 503 = Connect disabled in this env; anything else = a real failure.
        // The GET re-read above may still have produced a good state, so only
        // surface an error when we learned nothing at all.
        if (!resolved) {
          setError(String(data.error || 'Could not check your status — try again in a moment.'));
        }
        return;
      }
      if (resolved === 'active') {
        setRecheckMsg("You're all set — your bank is connected.");
        return;
      }
      setRecheckMsg(
        String(data.message || "Stripe hasn't finished verifying you yet — pick up where you left off above."),
      );
    } catch {
      setError('Network error — try again in a moment.');
    } finally {
      setBusy('');
    }
  };

  // While the legacy auto-advance effect is queued, render nothing — prevents a
  // flash of the tier_v2 UI for a legacy rancher.
  if (!isTierV2) return null;

  const working = busy !== '';

  // ── Per-state copy ───────────────────────────────────────────────────────
  // One state → one heading → one primary action. `read_failed` is folded in
  // as a fourth arm rather than a spinner-forever or a blank: we say we
  // couldn't check, and still give them the door.
  // `state` is either a LIVE read or the non-advancing cache — never a
  // cache-derived 'active' — so it is safe to paint before the read lands.
  //
  // But once the read has FAILED, an unverified cached value stops being a
  // reasonable stand-in: Airtable stores 'restricted' for accounts that are
  // still perfectly resumable, and acting on that would offer the Stripe
  // portal to a rancher whose actual fix is a fresh onboarding link. Fall back
  // to 'unknown', whose CTA (/connect/start) creates OR resumes and is
  // therefore right in every state.
  const trusted = state !== null && (fromLive || phase === 'loading');
  const shown: ConnectHandoffState | 'unknown' = trusted ? state! : 'unknown';

  // Keep the headline count and the bullet list in agreement. Two Stripe codes
  // can humanize to one phrase, so "Stripe still needs 3 things" above two
  // bullets reads as a bug; when we have a list, the list IS the count.
  const shownDueCount = due.length > 0 ? due.length : dueCount;

  return (
    <section className="space-y-6 bg-bone border border-dust p-7 md:p-8">
      <header>
        <p className="text-xs uppercase tracking-widest text-saddle mb-2">
          Get paid · Connect your bank
        </p>
        <h2 className="font-serif text-2xl md:text-3xl text-charcoal">
          {shown === 'active'
            ? 'Your bank is connected.'
            : shown === 'restricted'
              ? 'Stripe is holding your payout account.'
              : shown === 'incomplete'
                ? 'Pick up where you left off with Stripe.'
                : 'Connect your bank account.'}
        </h2>
        <p className="text-sm text-saddle mt-1">
          {shown === 'active' ? (
            <>
              Stripe verified you. Buyer deposits land straight in your account —
              BHC never touches your money.
            </>
          ) : shown === 'restricted' ? (
            <>
              Stripe has flagged something we can&rsquo;t clear from here. Open your
              Stripe account to see exactly what they need, or reply to your
              welcome email and we&rsquo;ll sort it with you.
            </>
          ) : shown === 'incomplete' ? (
            <>
              You started this already — Stripe just didn&rsquo;t get everything it
              needs. The button below drops you back at the next screen you owe
              them, with what you already entered still filled in.
            </>
          ) : (
            <>
              Stripe handles bank deposits directly. BHC never touches your money.
              You get paid the day after a buyer confirms beef delivery.
            </>
          )}
        </p>
      </header>

      {/* Loading: an honest, non-blocking placeholder — the actions render
          below regardless, so nobody can be stuck watching a spinner. */}
      {phase === 'loading' && (
        <p className="text-sm text-saddle italic" aria-live="polite">
          Checking with Stripe…
        </p>
      )}

      {/* NEVER STARTED — set the expectation out loud. The five ranchers who
          stalled all quit on Stripe's FIRST screen, which we never warned them
          about. Say what they'll be asked for, and why it's worth doing. */}
      {shown === 'never_started' && (
        <div className="space-y-4">
          <div className="border border-dust bg-bone-warm p-5 space-y-2.5 text-sm text-charcoal/85">
            <p className="text-xs uppercase tracking-widest text-saddle">
              What Stripe will ask you for — about 10 minutes
            </p>
            <ul className="space-y-1.5">
              <li>· Accepting Stripe&rsquo;s terms (their first screen — most people stop here; don&rsquo;t)</li>
              <li>· Your bank routing + account number, so deposits have somewhere to land</li>
              <li>· The last 4 of your SSN — Stripe is legally required to confirm who they&rsquo;re paying</li>
            </ul>
            <p className="text-xs text-saddle leading-relaxed pt-1">
              This is how your money lands in <em>your</em> account the day after
              delivery — no invoice, no waiting on us to cut you a check. You keep
              100% of the price you set; the buyer pays our fee on top. Encrypted
              end-to-end: BHC never sees your bank details.
            </p>
          </div>
        </div>
      )}

      {/* INCOMPLETE — the state five real ranchers are sitting in. Name what
          is ACTUALLY left, using #480's now-real currentlyDue list. */}
      {shown === 'incomplete' && (
        <div className="border border-amber-dark/40 bg-amber/10 p-5 space-y-2.5">
          <p className="text-xs uppercase tracking-widest text-amber-dark">
            {shownDueCount > 0
              ? `Stripe still needs ${shownDueCount} thing${shownDueCount === 1 ? '' : 's'} from you`
              : 'Stripe still needs a little more from you'}
          </p>
          {due.length > 0 ? (
            <ul className="space-y-1.5 text-sm text-charcoal/85">
              {due.map((item) => (
                <li key={item}>· {item}</li>
              ))}
            </ul>
          ) : phase !== 'loading' ? (
            <p className="text-sm text-charcoal/85">
              Stripe hasn&rsquo;t told us which screen you stopped on. Resuming takes
              you straight to it — usually accepting their terms, then your bank
              details.
            </p>
          ) : null}
          <p className="text-xs text-saddle leading-relaxed pt-1">
            Nothing you already entered is lost, and we&rsquo;ve pre-filled what we
            can. Usually a couple of minutes from here.
          </p>
        </div>
      )}

      {/* RESTRICTED — an onboarding loop cannot clear a Stripe-side hold, so we
          route to the account itself, exactly like the dashboard does. */}
      {shown === 'restricted' && (
        <div className="border border-weathered bg-weathered/10 p-5 space-y-2.5">
          <p className="text-xs uppercase tracking-widest text-weathered">
            Payouts are paused by Stripe
          </p>
          {due.length > 0 && (
            <ul className="space-y-1.5 text-sm text-charcoal/85">
              {due.map((item) => (
                <li key={item}>· {item}</li>
              ))}
            </ul>
          )}
          <p className="text-sm text-charcoal/85">
            Your page can&rsquo;t take deposits while this is open. Stripe will show
            you the specifics — and if it doesn&rsquo;t make sense, email{' '}
            <a
              href="mailto:hello@buyhalfcow.com"
              className="underline underline-offset-2 hover:text-charcoal"
            >
              hello@buyhalfcow.com
            </a>{' '}
            and we&rsquo;ll work it out with you.
          </p>
        </div>
      )}

      {/* ACTIVE — confirm plainly, then advance. Only ever reached from a LIVE
          read (the cache is never allowed to conclude 'active'), so there is no
          loading gate to add here. */}
      {shown === 'active' && (
        <div className="border border-sage bg-sage/10 p-5 space-y-1.5">
          <p className="text-xs uppercase tracking-widest text-sage-dark font-bold">
            Payouts ready
          </p>
          <p className="text-sm text-charcoal/85">
            Stripe has everything it needs. Buyer deposits go straight to your
            bank — you keep 100% of your price, and the buyer pays our fee on top.
          </p>
        </div>
      )}

      {/* READ FAILED — never a blank and never a spinner forever. Say we
          couldn't check, and give them the door anyway: /connect/start creates
          OR resumes, so this one button is right whichever state they're in. */}
      {phase === 'read_failed' && (
        <div className="border border-dust bg-bone-warm p-5 space-y-1.5">
          <p className="text-xs uppercase tracking-widest text-saddle">
            We couldn&rsquo;t reach Stripe just now
          </p>
          <p className="text-sm text-charcoal/85">
            That doesn&rsquo;t block you — the button below opens your payout setup
            and picks up wherever you actually are. If it keeps failing, email{' '}
            <a
              href="mailto:hello@buyhalfcow.com"
              className="underline underline-offset-2 hover:text-charcoal"
            >
              hello@buyhalfcow.com
            </a>
            .
          </p>
        </div>
      )}

      {error && (
        <div className="p-3 border border-rust text-rust text-sm">{error}</div>
      )}
      {recheckMsg && (
        <p className="text-sm text-saddle" aria-live="polite">
          {recheckMsg}
        </p>
      )}

      {/* ── ONE primary action per state ─────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 pt-2">
        {shown === 'active' ? (
          <button
            onClick={() => onComplete('active')}
            className="px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider"
          >
            Continue →
          </button>
        ) : shown === 'restricted' ? (
          <button
            onClick={openStripePortal}
            disabled={working}
            className="px-7 py-3.5 bg-rust text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-rust-dark disabled:opacity-50"
          >
            {busy === 'portal' ? 'Opening…' : 'Open my Stripe account →'}
          </button>
        ) : (
          <button
            onClick={goToStripe}
            disabled={working}
            className="px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider disabled:opacity-50"
          >
            {busy === 'start'
              ? 'Opening Stripe…'
              : shown === 'incomplete'
                ? 'Resume on Stripe →'
                : shown === 'never_started'
                  ? 'Connect bank — about 10 min →'
                  : // Status unread: /connect/start creates OR resumes, so the
                    // button is right either way — but don't imply "fresh
                    // start" (or a 10-minute budget) to someone mid-KYC.
                    'Open Stripe payout setup →'}
          </button>
        )}

        {/* Self-serve re-check. Not shown once active — there is nothing left
            to re-check, and a second button would blunt the one that matters. */}
        {shown !== 'active' && (
          <button
            onClick={recheck}
            disabled={working}
            className="text-xs uppercase tracking-widest text-saddle underline underline-offset-4 hover:text-charcoal disabled:opacity-50"
          >
            {busy === 'recheck' ? 'Checking…' : 'I finished — re-check'}
          </button>
        )}
      </div>

      {shown !== 'active' && (
        <p className="text-xs text-saddle/80">
          This step is required — buyers pay deposits straight to your bank, so we
          can&rsquo;t take your page live until Stripe has verified you. Not ready
          this minute? Close this and pick up <em>exactly here</em> later; your
          page stays unpublished until your bank is connected.
        </p>
      )}

      {onBack && (
        <div className="pt-2">
          <button
            onClick={onBack}
            className="text-xs uppercase tracking-widest text-saddle hover:text-charcoal transition-colors"
          >
            ← Back
          </button>
        </div>
      )}
    </section>
  );
}
