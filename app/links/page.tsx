// /links — THE bio hub (attention→revenue landing layer).
//
// SHARES-FIRST (founder directive 2026-07-08): the business is whole/half/
// quarter shares — the bio page leads with the share reservation as a HERO
// card and demotes everything else to compact rungs (taste-first shop,
// guide capture, gear+merch pair). Rancher/creator stay one quiet text line.
//
// Mechanics that shape it (unchanged):
//   - Own-domain (never Linktree): speed, pixel attribution, zero third-party
//     chrome between attention and money.
//   - Chrome-sealed via ChromeGate (FOCUSED_PREFIXES): no nav, no footer
//     buffet — the rungs ARE the page. Same discipline as checkout.
//   - Static + fast: no data reads — this page must win the 3-second mobile
//     load. Every tap fires a tracked links_* event for the weekly read.

import type { Metadata } from 'next';
import Image from 'next/image';
import LinksButtons from './LinksButtons';

export const metadata: Metadata = {
  title: 'BuyHalfCow — real beef, real ranchers',
  description:
    'Reserve a whole, half, or quarter beef share from a verified family ranch — or shop ranch beef shipped to your door.',
  robots: { index: false }, // a routing surface, not a search destination
};

export default function LinksPage() {
  return (
    <main className="min-h-screen bg-bone text-charcoal px-5 py-10">
      <div className="max-w-[440px] mx-auto space-y-6">
        <div className="text-center space-y-3">
          <Image
            src="/bhc-logo.png"
            alt="BuyHalfCow"
            width={64}
            height={64}
            className="mx-auto rounded-full border border-dust"
            priority
          />
          <p className="font-serif text-[22px] leading-none">buyhalfcow</p>
          <p className="text-[14px] text-saddle leading-relaxed max-w-[36ch] mx-auto">
            i connect families to verified ranches for real beef — a whole,
            half, or quarter at a time. &mdash; Ben
          </p>
        </div>

        <LinksButtons />

        {/* Trust strip — same honest three beats as the shop rail. */}
        <p className="text-center text-[11.5px] text-dust leading-relaxed">
          verified ranches · secured by stripe · if anything shows up wrong, we make it right
        </p>

        <p className="text-center text-xs text-saddle border-t border-dust pt-4">
          raise cattle?{' '}
          <a href="/sell" className="underline hover:text-charcoal transition-colors">
            sell direct — free to join
          </a>
          {' · '}creator?{' '}
          <a href="/partners" className="underline hover:text-charcoal transition-colors">
            partner with us
          </a>
        </p>
      </div>
    </main>
  );
}
