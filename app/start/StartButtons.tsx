'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { trackEvent } from '@/lib/analytics';

// Quiet single-primary CTA. No subtext crammed inside. Width-full
// charcoal button. Pairs with surrounding whitespace + type hierarchy
// to feel like editorial design, not a marketing slab.

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
      <div className="px-6 py-5 flex items-center justify-between">
        <span className="font-medium text-base sm:text-lg tracking-wide">
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

export function SecondaryLink({
  href,
  label,
  meta,
  route,
}: {
  href: string;
  label: string;
  meta?: string;
  route: 'founder' | 'brand' | 'rancher';
}) {
  return (
    <Link
      href={href}
      onClick={() => trackEvent('start_button_click', { route })}
      className="group flex items-baseline justify-between gap-4 py-3 border-b border-dust hover:border-charcoal transition-base"
    >
      <span className="text-charcoal">{label}</span>
      <span className="flex items-baseline gap-3 flex-shrink-0">
        {meta && (
          <span className="text-xs text-saddle hidden sm:inline">{meta}</span>
        )}
        <span
          aria-hidden="true"
          className="text-charcoal transition-transform group-hover:translate-x-1"
        >
          →
        </span>
      </span>
    </Link>
  );
}
