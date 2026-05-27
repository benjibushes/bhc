'use client';

// Client analytics islands for the /founders server-component page.
//
// Wires the 4 founders_* events declared in lib/analytics.ts that were
// previously NEVER fired (audit 2026-05-26, F4):
//
//   • founders_view             — page mount
//   • founders_backed           — post-Stripe redirect-back (?paid=1 or ?success=1)
//   • founders_tier_click       — every tier-card click (link tiers via this file;
//                                 checkout-button tiers via FounderCheckoutButton)
//
// The page itself stays a server component (async, ISR, Airtable fetch).
// These islands are rendered inline where needed.

import { useEffect } from 'react';
import { trackEvent } from '@/lib/analytics';

/**
 * Mount-time page-view tracker. Also fires founders_backed when Stripe has
 * redirected the user back with ?success=1 or ?paid=<tier>. Reads the tier
 * + (best-effort) session_id from the URL so attribution carries forward
 * to Meta/GA.
 */
export function FoundersViewTracker() {
  useEffect(() => {
    trackEvent('founders_view');

    if (typeof window === 'undefined') return;
    try {
      const sp = new URLSearchParams(window.location.search);
      const success = sp.get('success') === '1';
      const paid = sp.get('paid');
      if (success || paid) {
        const props: Record<string, string> = {};
        const tier = paid || sp.get('tier') || '';
        if (tier) props.tier = tier;
        const sessionId = sp.get('session_id');
        if (sessionId) props.session_id = sessionId;
        trackEvent('founders_backed', props);
      }
    } catch {
      // Never let analytics break the page render.
    }
  }, []);
  return null;
}

/**
 * Client wrapper around the existing <a href> Stripe Payment Link buttons.
 * Fires founders_tier_click BEFORE navigation. fbq + gtag dispatch
 * synchronously enough that the same-tab navigation still ships the event.
 */
export function TierLinkButton({
  tier,
  href,
  label,
  className,
}: {
  tier: string;
  href: string;
  label: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      onClick={() => trackEvent('founders_tier_click', { tier })}
      className={
        className ??
        'block text-center px-6 py-3.5 text-sm font-medium tracking-wide uppercase bg-charcoal text-bone transition-base hover:bg-divider'
      }
    >
      {label}
    </a>
  );
}
