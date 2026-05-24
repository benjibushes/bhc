'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { trackEvent } from '@/lib/analytics';

// Primary buyer CTA — full-width charcoal slab. No subtext crammed
// inside; trust signal renders directly below the button in the page.

export default function PrimaryBuyerCTA() {
  useEffect(() => {
    trackEvent('start_view');
  }, []);

  return (
    <Link
      href="/access"
      onClick={() => trackEvent('start_button_click', { route: 'buyer' })}
      className="group block w-full bg-charcoal text-bone hover:bg-divider transition-base"
    >
      <div className="px-6 py-5 sm:py-6 flex items-center justify-between">
        <span className="font-medium text-base sm:text-lg uppercase tracking-wider">
          get matched in 90 seconds
        </span>
        <span
          aria-hidden="true"
          className="text-2xl transition-transform group-hover:translate-x-1"
        >
          →
        </span>
      </div>
    </Link>
  );
}

// Founders Herd card — distinct card w/ scarcity progress + scarcity
// copy. Bone-warm bg, charcoal border, prominent claim button.

export function FounderCard({
  foundersBacked,
  foundersCap,
}: {
  foundersBacked: number;
  foundersCap: number;
}) {
  const foundersLeft = Math.max(0, foundersCap - foundersBacked);
  const foundersFullyClaimed = foundersLeft === 0;
  const pct = Math.min(100, (foundersBacked / foundersCap) * 100);

  if (foundersFullyClaimed) {
    return (
      <Link
        href="/wins"
        onClick={() => trackEvent('start_button_click', { route: 'founder' })}
        className="group block bg-charcoal text-bone hover:bg-divider transition-base p-6"
      >
        <div className="text-xs uppercase tracking-wider text-bone/60 mb-2">
          founding herd · 100 / 100 claimed
        </div>
        <div className="font-serif text-2xl leading-tight mb-2">
          see what the herd built
        </div>
        <div className="flex items-center justify-between mt-4">
          <span className="text-sm uppercase tracking-wider font-semibold">
            view wins
          </span>
          <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">→</span>
        </div>
      </Link>
    );
  }

  return (
    <Link
      href="/founders"
      onClick={() => trackEvent('start_button_click', { route: 'founder' })}
      className="group block bg-bone-warm border-2 border-charcoal hover:bg-bone-deep transition-base p-6"
    >
      <div className="flex items-baseline justify-between mb-3">
        <span className="text-xs uppercase tracking-wider text-saddle font-semibold">
          founding herd
        </span>
        <span className="text-xs font-semibold text-charcoal">
          {foundersBacked} / {foundersCap} claimed
        </span>
      </div>
      <div className="h-1 bg-bone border border-dust mb-4 overflow-hidden">
        <div className="h-full bg-charcoal" style={{ width: `${pct}%` }} />
      </div>
      <div className="font-serif text-xl sm:text-2xl text-charcoal leading-tight mb-2">
        back the founding herd
      </div>
      <p className="text-sm text-saddle mb-5">
        from $100. lock founder #1-10 status with $15k tier. funds the next
        100 ranchers we onboard.
      </p>
      <div className="flex items-center justify-between">
        <span className="text-sm uppercase tracking-wider font-semibold text-charcoal">
          back the herd
        </span>
        <span
          aria-hidden="true"
          className="text-charcoal transition-transform group-hover:translate-x-1"
        >
          →
        </span>
      </div>
    </Link>
  );
}

// Brand Partner card — bone bg, charcoal border, tier price list.

export function BrandCard() {
  return (
    <Link
      href="/brand-partners"
      onClick={() => trackEvent('start_button_click', { route: 'brand' })}
      className="group block bg-bone border-2 border-charcoal hover:bg-bone-warm transition-base p-6"
    >
      <div className="flex items-baseline justify-between mb-3">
        <span className="text-xs uppercase tracking-wider text-saddle font-semibold">
          brand partner
        </span>
        <span className="text-xs font-semibold text-charcoal">
          from $99/mo
        </span>
      </div>
      <div className="font-serif text-xl sm:text-2xl text-charcoal leading-tight mb-2">
        get your brand in front of d2c ranchers
      </div>
      <p className="text-sm text-saddle mb-5">
        $99 spotlight · $499 featured · $1,500 founding partner. the
        families who buy direct + the ranchers who feed them.
      </p>
      <div className="flex items-center justify-between">
        <span className="text-sm uppercase tracking-wider font-semibold text-charcoal">
          see tiers
        </span>
        <span
          aria-hidden="true"
          className="text-charcoal transition-transform group-hover:translate-x-1"
        >
          →
        </span>
      </div>
    </Link>
  );
}
