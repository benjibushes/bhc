'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { trackEvent } from '@/lib/analytics';

// Rev-tier ordering matters. Direct $-driving CTAs first (buyer →
// founder → brand). Rancher join is supply-side (indirect $) and
// lives last as a secondary tier-2 action.
//
// Labels carry price/value anchors so a cold visitor sees what each
// path costs + what they get without clicking. Per CRO research, price
// anchoring at the CTA itself lifts qualified click-through 15-30%
// vs labels that just describe action.

interface Button {
  href: string;
  label: string;
  sublabel?: string;
  route: 'buyer' | 'founder' | 'brand' | 'rancher';
  // 'primary' = direct $ path, 'secondary' = supply / indirect
  tier: 'primary' | 'secondary';
}

export default function StartButtons({
  foundersBacked,
  foundersCap,
}: {
  foundersBacked: number;
  foundersCap: number;
}) {
  useEffect(() => {
    trackEvent('start_view');
  }, []);

  const foundersLeft = Math.max(0, foundersCap - foundersBacked);
  const foundersFullyClaimed = foundersLeft === 0;

  const buttons: Button[] = [
    {
      href: '/access',
      label: 'get matched to a rancher',
      sublabel: 'free · 90-second quiz · routed in your state',
      route: 'buyer',
      tier: 'primary',
    },
    {
      href: foundersFullyClaimed ? '/wins' : '/founders',
      label: foundersFullyClaimed
        ? 'founders herd full · see the wins'
        : 'back the founding herd',
      sublabel: foundersFullyClaimed
        ? `100 of 100 claimed · waitlist on /founders`
        : `$100 – $15k · ${foundersBacked} of ${foundersCap} claimed`,
      route: 'founder',
      tier: 'primary',
    },
    {
      href: '/brand-partners',
      label: 'become a brand partner',
      sublabel: '$99/mo spotlight · $499/mo featured · $1,500 founding',
      route: 'brand',
      tier: 'primary',
    },
    {
      href: '/map/add-a-rancher',
      label: "i'm a rancher · join the network",
      sublabel: 'free · 5-minute setup · keep 90% per sale',
      route: 'rancher',
      tier: 'secondary',
    },
  ];

  const primary = buttons.filter((b) => b.tier === 'primary');
  const secondary = buttons.filter((b) => b.tier === 'secondary');

  return (
    <div className="space-y-3">
      {/* Primary tier — direct $ CTAs, large card style */}
      {primary.map((b) => (
        <Link
          key={b.route}
          href={b.href}
          onClick={() => trackEvent('start_button_click', { route: b.route })}
          className="block w-full bg-charcoal text-bone hover:bg-divider transition-base active:scale-[0.98] px-6 py-5"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="text-left">
              <div className="font-semibold text-sm sm:text-base uppercase tracking-wider leading-snug">
                {b.label}
              </div>
              {b.sublabel && (
                <div className="text-xs sm:text-sm text-bone/70 mt-1 normal-case tracking-normal">
                  {b.sublabel}
                </div>
              )}
            </div>
            <span aria-hidden="true" className="text-bone/60 text-xl">→</span>
          </div>
        </Link>
      ))}

      {/* Divider before secondary tier */}
      <div className="pt-4 mt-4 border-t border-dust">
        <p className="text-xs text-saddle uppercase tracking-wider mb-2">
          run a ranch?
        </p>
        {secondary.map((b) => (
          <Link
            key={b.route}
            href={b.href}
            onClick={() => trackEvent('start_button_click', { route: b.route })}
            className="block w-full bg-bone text-charcoal border border-charcoal hover:bg-charcoal hover:text-bone transition-base px-6 py-4"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="text-left">
                <div className="font-semibold text-sm uppercase tracking-wider leading-snug">
                  {b.label}
                </div>
                {b.sublabel && (
                  <div className="text-xs text-saddle mt-1 normal-case tracking-normal group-hover:text-bone/70">
                    {b.sublabel}
                  </div>
                )}
              </div>
              <span aria-hidden="true" className="text-xl">→</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
