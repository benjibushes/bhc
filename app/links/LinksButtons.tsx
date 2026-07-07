'use client';

// Bio-hub buttons — ranked by the RPM/intent research: tripwire → quiz →
// capture → gear. Each tap fires a tracked event so Ben can see which rung
// his bio traffic actually takes (the weekly-read numbers).

import Link from 'next/link';
import { useEffect } from 'react';
import { trackEvent, type AnalyticsEventName } from '@/lib/analytics';

const LINKS: {
  href: string;
  title: string;
  sub: string;
  event: AnalyticsEventName;
  primary?: boolean;
}[] = [
  {
    href: '/shop',
    title: '🥩 shop beef — shipped to your door',
    sub: 'jerky from $13.59 · boxes · ground — shipping included, from verified ranches',
    event: 'links_shop',
    primary: true,
  },
  {
    href: '/access',
    title: '🧊 fill your freezer — half or whole share',
    sub: '90-second quiz, we match you to a ranch near you · deposit fully refundable',
    event: 'links_access',
  },
  {
    href: '/guide',
    title: '📖 free guide: the real cost of a half cow',
    sub: 'the honest math — what it costs, what you get, how much freezer you need',
    event: 'links_guide',
  },
  {
    href: '/gear',
    title: 'the gear ben actually uses',
    sub: 'freezers, grills, knives — the tools behind the beef',
    event: 'links_gear',
  },
];

export default function LinksButtons() {
  useEffect(() => {
    trackEvent('links_view');
  }, []);

  return (
    <div className="space-y-3">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          onClick={() => trackEvent(l.event)}
          className={
            l.primary
              ? 'block bg-charcoal text-bone p-4 text-center transition-base hover:bg-saddle'
              : 'block bg-bone-warm border border-charcoal text-charcoal p-4 text-center transition-base hover:bg-bone-deep'
          }
        >
          <span className="block font-medium text-[15.5px]">{l.title}</span>
          <span className={`block text-[12px] mt-1 ${l.primary ? 'text-bone/75' : 'text-saddle'}`}>
            {l.sub}
          </span>
        </Link>
      ))}
    </div>
  );
}
