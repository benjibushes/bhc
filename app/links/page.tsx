// /links — THE bio hub (attention→revenue landing layer, 2026-07-06).
//
// This is the page the bio points at: the one tap every social visitor makes.
// Mechanics that shape it:
//   - Own-domain (never Linktree): keeps speed, pixel attribution, and zero
//     third-party chrome between attention and money.
//   - BUYER-ONLY + intent-RANKED (research killed 4-equal-audience grids):
//     tripwire first ($13 anyone can say yes to), share quiz second, capture
//     third, gear last. Partner/rancher = one quiet text line.
//   - Chrome-sealed via ChromeGate (added to FOCUSED_PREFIXES): no nav, no
//     footer buffet — the four buttons ARE the page. A routing room, same
//     discipline as checkout.
//   - One-line risk-reversal under each button (the microcopy pattern that
//     holds mobile taps).
//
// Static + fast: no data reads — this page must win the 3-second mobile load.

import type { Metadata } from 'next';
import LinksButtons from './LinksButtons';

export const metadata: Metadata = {
  title: 'BuyHalfCow — real beef, real ranchers',
  description:
    'Shop real ranch beef shipped to your door, reserve a half-cow share, or grab the free guide to what a half cow actually costs.',
  robots: { index: false }, // a routing surface, not a search destination
};

export default function LinksPage() {
  return (
    <main className="min-h-screen bg-bone text-charcoal px-5 py-10">
      <div className="max-w-[440px] mx-auto space-y-7">
        <div className="text-center space-y-2">
          <p className="font-serif text-2xl">buyhalfcow</p>
          <p className="text-[14.5px] text-saddle leading-relaxed">
            real beef from named family ranches — shipped to your door, or a
            half-cow straight into your freezer. &mdash; Ben
          </p>
        </div>

        <LinksButtons />

        <p className="text-center text-xs text-saddle pt-1">
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
