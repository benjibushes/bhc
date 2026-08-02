'use client';

// ── Go-live progress ribbon (dashboard UX upgrade, 2026-07-15) ─────────────
// For not-yet-live ranchers only: a compact Profile → Bank → Live ribbon
// with ONE next-step CTA, so the first thing a new rancher sees is exactly
// how far they are from receiving buyers. Hidden entirely once the page is
// live AND payouts are active (legacy ranchers have no bank step — for them
// the ribbon is Profile → Live and hides on page-live).
//
// ZERO new rails: every CTA reuses the exact links/endpoints the dashboard
// already exposes —
//   • profile / publish   → the My Page tab (same target as setupSteps)
//   • connect the bank    → POST /api/rancher/connect/start (the cascade's
//                           openConnectOnboarding rail)
//   • restricted account  → GET /api/rancher/connect/status then start-or-
//                           portal (the cascade's resolveRestricted rail)
//   • no tier picked yet  → /rancher/billing (its no-tier state renders the
//                           three plan checkouts)

import { useState } from 'react';

interface Step {
  key: 'profile' | 'bank' | 'live';
  label: string;
  done: boolean;
}

export default function ProgressRibbon({
  pricingModel,
  connectStatus,
  tier,
  pageLive,
  profileDone,
  onGoToMyPage,
}: {
  pricingModel?: string;
  connectStatus?: string;
  tier?: string | null;
  pageLive: boolean;
  /** Price + photo present (the two profile setupSteps). */
  profileDone: boolean;
  onGoToMyPage: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const isTierV2 = String(pricingModel || '').toLowerCase() === 'tier_v2';
  const connect = String(connectStatus || 'not_connected').toLowerCase();
  const bankDone = !isTierV2 || connect === 'active';

  // Hide entirely when live + payouts active (the whole point: the ribbon
  // exists only while there's a gap between the rancher and their buyers).
  if (pageLive && bankDone) return null;

  const steps: Step[] = [
    { key: 'profile', label: 'Profile', done: profileDone },
    // Legacy ranchers self-collect — no bank step for them.
    ...(isTierV2 ? [{ key: 'bank', label: 'Bank', done: bankDone } as Step] : []),
    { key: 'live', label: 'Live', done: pageLive },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);

  // Same rail the banner cascade's openConnectOnboarding uses — start
  // re-mints a fresh Stripe account link every call, so an abandoned KYC
  // resumes at the next required step instead of an expired-link wall.
  async function openConnectOnboarding() {
    setErr('');
    setBusy(true);
    try {
      const res = await fetch('/api/rancher/connect/start', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      // Same-tab navigation, NOT window.open. This fires after an await, so it
      // is outside the user-gesture stack — iOS Safari and Android Chrome
      // silently block the popup and the rancher just sees the button say
      // "Opening…" and then nothing. The setup wizard uses location.href and
      // works; that is why starters finish Connect and returners don't.
      if (res.ok && data?.url) window.location.href = data.url;
      else setErr(data?.error || 'Could not start Stripe onboarding — try again in a moment.');
    } catch {
      setErr('Network error — try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  // Same rail as the cascade's resolveRestricted: one live status read
  // decides between a fresh onboarding link (the dominant stuck case) and
  // the Stripe billing portal.
  async function resolveRestricted() {
    setErr('');
    setBusy(true);
    try {
      const statusRes = await fetch('/api/rancher/connect/status', { credentials: 'include' });
      const statusData = await statusRes.json().catch(() => ({} as any));
      if (statusRes.ok && statusData?.canResumeOnboarding === true) {
        await openConnectOnboarding();
        return;
      }
      const res = await fetch('/api/rancher/tier/portal', { credentials: 'include' });
      const data = await res.json();
      // Same-tab navigation — see the note in openConnectOnboarding above.
      if (res.ok && data?.url) window.location.href = data.url;
      else setErr(data?.error || 'Could not open the billing portal.');
    } catch {
      setErr('Network error — try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  // ONE next-step CTA.
  let cta: { label: string; onClick?: () => void; href?: string } | null = null;
  if (next?.key === 'profile') {
    cta = { label: 'finish your profile →', onClick: onGoToMyPage };
  } else if (next?.key === 'bank') {
    if (isTierV2 && !tier) {
      // Can't onboard with Stripe before a plan exists — the billing page's
      // no-tier state renders the three plan checkouts.
      cta = { label: 'pick your plan →', href: '/rancher/billing' };
    } else if (connect === 'restricted') {
      cta = { label: 'fix payout setup →', onClick: resolveRestricted };
    } else {
      cta = {
        label: connect === 'onboarding' ? 'finish payout setup →' : 'connect your bank →',
        onClick: openConnectOnboarding,
      };
    }
  } else if (next?.key === 'live') {
    cta = { label: 'publish your page →', onClick: onGoToMyPage };
  }

  return (
    <section
      aria-label="Steps to go live"
      className="border border-dust bg-bone-warm p-5 rounded-sm space-y-4"
    >
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="font-serif text-2xl">almost live</h2>
        <span className="text-sm text-saddle">
          {doneCount} of {steps.length} done
        </span>
      </div>

      {/* Step dots — thumb-sized, wraps on narrow screens. */}
      <ol className="flex items-center gap-2 flex-wrap">
        {steps.map((step, i) => (
          <li key={step.key} className="flex items-center gap-2">
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className={`w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${
                  step.done
                    ? 'bg-sage text-bone'
                    : step.key === next?.key
                      ? 'bg-amber text-charcoal'
                      : 'bg-bone-deep text-dust'
                }`}
              >
                {step.done ? '✓' : i + 1}
              </span>
              <span
                className={`text-sm ${
                  step.done
                    ? 'text-saddle'
                    : step.key === next?.key
                      ? 'font-medium text-charcoal'
                      : 'text-dust'
                }`}
              >
                {step.label}
                {step.done ? '' : step.key === next?.key ? ' — next' : ''}
              </span>
            </span>
            {i < steps.length - 1 && (
              <span aria-hidden className="w-6 h-px bg-dust shrink-0" />
            )}
          </li>
        ))}
      </ol>

      {cta &&
        (cta.href ? (
          <a
            href={cta.href}
            className="inline-flex items-center rounded-full bg-charcoal text-bone px-6 py-2.5 min-h-[44px] text-xs font-semibold uppercase tracking-widest hover:bg-saddle transition-colors"
          >
            {cta.label}
          </a>
        ) : (
          <button
            type="button"
            onClick={cta.onClick}
            disabled={busy}
            className="inline-flex items-center rounded-full bg-charcoal text-bone px-6 py-2.5 min-h-[44px] text-xs font-semibold uppercase tracking-widest hover:bg-saddle transition-colors disabled:opacity-60"
          >
            {busy ? 'opening…' : cta.label}
          </button>
        ))}

      {err && (
        <div className="p-3 border-l-4 border-weathered bg-weathered/10 text-sm text-weathered flex items-center justify-between gap-3">
          <span>{err}</span>
          <button
            type="button"
            onClick={() => setErr('')}
            className="text-lg leading-none hover:opacity-70"
          >
            ×
          </button>
        </div>
      )}
    </section>
  );
}
