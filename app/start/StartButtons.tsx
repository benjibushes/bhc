'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { trackEvent } from '@/lib/analytics';

// Single dominant primary CTA. Visual hierarchy: buyer route is the
// largest visible action because every buyer-click maps to potential
// $-direct revenue via 10% commission. Founders + Brand are secondary
// cards rendered separately by the page (different visual treatment).
// Rancher join is a tertiary text link, NOT a button — it's supply
// side, indirect $, and shouldn't compete visually with buyer CTAs.

export default function PrimaryBuyerCTA() {
  useEffect(() => {
    trackEvent('start_view');
  }, []);

  return (
    <Link
      href="/access"
      onClick={() => trackEvent('start_button_click', { route: 'buyer' })}
      className="group block w-full bg-charcoal text-bone hover:bg-divider transition-base active:scale-[0.99] overflow-hidden"
    >
      <div className="px-6 py-7 sm:px-8 sm:py-9 flex items-center justify-between gap-4">
        <div className="text-left">
          <div className="font-serif text-2xl sm:text-3xl leading-tight mb-1.5">
            get matched in 90 seconds
          </div>
          <div className="text-xs sm:text-sm text-bone/70 normal-case">
            free · no card · routed in your state · you talk direct
          </div>
        </div>
        <span
          aria-hidden="true"
          className="text-bone text-3xl flex-shrink-0 transition-transform group-hover:translate-x-1"
        >
          →
        </span>
      </div>
    </Link>
  );
}

export function FounderCTA({
  foundersBacked,
  foundersCap,
}: {
  foundersBacked: number;
  foundersCap: number;
}) {
  const foundersLeft = Math.max(0, foundersCap - foundersBacked);
  const foundersFullyClaimed = foundersLeft === 0;

  if (foundersFullyClaimed) {
    return (
      <Link
        href="/wins"
        onClick={() => trackEvent('start_button_click', { route: 'founder' })}
        className="group block w-full border border-charcoal bg-charcoal text-bone hover:bg-divider transition-base"
      >
        <div className="px-5 py-4 flex items-center justify-between gap-4">
          <div className="text-left">
            <div className="text-xs uppercase tracking-wider text-bone/60 mb-1">
              founding herd · 100 / 100 claimed
            </div>
            <div className="font-medium text-sm sm:text-base">
              see what the herd built →
            </div>
          </div>
        </div>
      </Link>
    );
  }

  // Be founder #N framing — 0 claimed is bad social proof; "be founder #1"
  // turns absence into invitation.
  const nextFounderNumber = foundersBacked + 1;

  return (
    <Link
      href="/founders"
      onClick={() => trackEvent('start_button_click', { route: 'founder' })}
      className="group block w-full border-2 border-charcoal bg-bone-warm hover:bg-bone-deep transition-base"
    >
      <div className="px-5 py-4 sm:px-6 sm:py-5">
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-xs uppercase tracking-wider text-saddle">
            ⭐ founding herd
          </span>
          <span className="text-xs font-semibold text-charcoal">
            {foundersBacked} / {foundersCap} claimed
          </span>
        </div>
        <div className="font-serif text-lg sm:text-xl text-charcoal leading-snug mb-1">
          be founder #{nextFounderNumber}
        </div>
        <div className="text-xs sm:text-sm text-saddle mb-3">
          $100 backs the mission · $15k locks founder #1-10 forever
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-charcoal">
            back the herd
          </span>
          <span
            aria-hidden="true"
            className="text-charcoal transition-transform group-hover:translate-x-1"
          >
            →
          </span>
        </div>
      </div>
    </Link>
  );
}

export function BrandCTA() {
  return (
    <Link
      href="/brand-partners"
      onClick={() => trackEvent('start_button_click', { route: 'brand' })}
      className="group block w-full border border-charcoal bg-bone hover:bg-bone-warm transition-base"
    >
      <div className="px-5 py-4 sm:px-6 sm:py-5">
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-xs uppercase tracking-wider text-saddle">
            💼 brand partner
          </span>
          <span className="text-xs font-semibold text-charcoal">
            from $99/mo
          </span>
        </div>
        <div className="font-serif text-lg sm:text-xl text-charcoal leading-snug mb-1">
          get your brand in front of d2c ranchers
        </div>
        <div className="text-xs sm:text-sm text-saddle mb-3">
          $99 spotlight · $499 featured · $1,500 founding
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-charcoal">
            see tiers
          </span>
          <span
            aria-hidden="true"
            className="text-charcoal transition-transform group-hover:translate-x-1"
          >
            →
          </span>
        </div>
      </div>
    </Link>
  );
}

export function RancherTextLink() {
  return (
    <Link
      href="/map/add-a-rancher"
      onClick={() => trackEvent('start_button_click', { route: 'rancher' })}
      className="group inline-flex items-baseline gap-2 text-charcoal hover:text-saddle transition-base"
    >
      <span className="text-sm sm:text-base">
        run a ranch? <span className="underline underline-offset-2">join the network</span>
      </span>
      <span
        aria-hidden="true"
        className="text-charcoal transition-transform group-hover:translate-x-1"
      >
        →
      </span>
    </Link>
  );
}
