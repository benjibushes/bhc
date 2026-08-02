'use client';

// Bio-hub rungs — SHARES-FIRST (founder directive 2026-07-08, supersedes the
// shop-first default from the attention research: supply is activating and
// the share IS the business; the bio leads with it).
//
// Layout: one HERO card (the share reservation — serif, price-anchored,
// risk-reversed) → shop tripwire → find-a-ranch map → wins (social proof) →
// guide capture → gear+merch as a compact half-width pair. Every tap fires
// the same tracked events as before so the weekly read of which rung bio
// traffic takes stays continuous.
//
// REWORK 2026-08-02 (post-fleet /links audit):
//   - Emoji icons (🥩📍📖🧢) → small inline SVG strokes. Emoji render
//     differently per platform and clash with the paper-western system;
//     one consistent 18px stroke set matches the brand.
//   - Type floor: nothing under 12px (was 11/11.5px), subtitles 13px.
//   - Hardcoded prices removed ("jerky from $13.59", "tees from $20") —
//     this page is deliberately static (3-second mobile budget, no data
//     reads), so any literal price WILL rot. Copy sells the category.
//   - /wins rung added — real closed deals are the strongest proof this
//     page can carry, and it costs one row.
//
// CORNERS (2026-07-09): every card carries an explicit `rounded-sm` (2px,
// the paper-edge radius used site-wide). This is NOT cosmetic — the global
// button-softener in globals.css (`a[class*="bg-charcoal"]:not([rounded])`
// → border-radius 9999px) was pilling the tall charcoal HERO card into a
// black ellipse that clipped its own text. Any `rounded-*` class opts a
// card out of that rule. Keep it on the hero.

import Link from 'next/link';
import { useEffect } from 'react';
import { trackEvent } from '@/lib/analytics';

// 18px inline stroke icons — one visual language (1.75 stroke, round caps),
// aria-hidden: the label text carries the meaning.
const icon = {
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fill: 'none',
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  'aria-hidden': true as const,
  className: 'inline-block align-[-3px] mr-1.5',
};

// Package/box — this rung sells shipped-to-your-door product, and a box
// stroke reads instantly at 18px (a "steak" outline read as an eyeball).
const IconBox = () => (
  <svg {...icon}>
    <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
    <path d="M4 7l8 4 8-4M12 11v9" />
  </svg>
);
const IconPin = () => (
  <svg {...icon}>
    <path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11Z" />
    <circle cx="12" cy="10" r="2.5" />
  </svg>
);
const IconTrophy = () => (
  <svg {...icon}>
    <path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" />
    <path d="M8 5H5v1a3 3 0 0 0 3 3M16 5h3v1a3 3 0 0 1-3 3" />
    <path d="M12 13v3m-3 4h6m-5-4h4l1 4H8l1-4Z" />
  </svg>
);
const IconBook = () => (
  <svg {...icon}>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" />
    <path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20" />
  </svg>
);
const IconCap = () => (
  <svg {...icon}>
    <path d="M4 13a8 8 0 0 1 16 0v1H7" />
    <path d="M4 13v1c0 .6.4 1 1 1h2v-2" />
  </svg>
);

export default function LinksButtons() {
  useEffect(() => {
    trackEvent('links_view');
  }, []);

  return (
    <div className="space-y-3">
      {/* ── HERO — the share. The one thing this page exists to sell. ── */}
      <Link
        href="/access"
        onClick={() => trackEvent('links_access')}
        className="block rounded-sm elev bg-charcoal text-bone px-6 py-7 text-center transition-base hover:bg-saddle"
      >
        <span className="block text-xs uppercase tracking-[0.2em] text-tallow mb-2">
          whole · half · quarter
        </span>
        <span className="block font-serif text-[25px] leading-tight">
          fill your freezer with one ranch&rsquo;s beef
        </span>
        <span className="block text-[13px] mt-2.5 text-bone/75 leading-snug max-w-[34ch] mx-auto">
          steaks, roasts, and ground at one honest price per pound — from a
          named ranch we verified. 90 seconds to get matched.
        </span>
        <span className="mt-5 inline-block rounded-full bg-tallow text-charcoal px-7 py-3 text-[13px] font-semibold uppercase tracking-wider">
          reserve your share &rarr;
        </span>
        <span className="block text-xs mt-3 text-bone/60">
          deposit holds your spot · fully refundable until your rancher accepts
        </span>
      </Link>

      {/* ── rung 2: tripwire — taste it first ── */}
      <Link
        href="/shop"
        onClick={() => trackEvent('links_shop')}
        className="block rounded-sm bg-bone-warm border border-charcoal text-charcoal p-4 text-center transition-base hover:bg-bone-deep"
      >
        <span className="block font-medium text-[15.5px]">
          <IconBox />
          not ready for a freezer-full? taste it first
        </span>
        <span className="block text-[13px] mt-1 text-saddle">
          jerky · boxes · ground — shipped nationwide from the same ranches
        </span>
      </Link>

      {/* ── rung 3: discovery — see who's near you ── */}
      <Link
        href="/map"
        onClick={() => trackEvent('links_map')}
        className="block rounded-sm bg-bone-warm border border-dust text-charcoal p-4 text-center transition-base hover:bg-bone-deep"
      >
        <span className="block font-medium text-[15px]">
          <IconPin />
          find a verified ranch near you
        </span>
        <span className="block text-[13px] mt-1 text-saddle">
          browse the map — real family ranches, state by state
        </span>
      </Link>

      {/* ── rung 4: proof — real families, real closes ── */}
      <Link
        href="/wins"
        onClick={() => trackEvent('links_wins')}
        className="block rounded-sm bg-bone-warm border border-dust text-charcoal p-4 text-center transition-base hover:bg-bone-deep"
      >
        <span className="block font-medium text-[15px]">
          <IconTrophy />
          see the freezers we&rsquo;ve filled
        </span>
        <span className="block text-[13px] mt-1 text-saddle">
          real families, real ranches — the wins wall
        </span>
      </Link>

      {/* ── rung 5: capture ── */}
      <Link
        href="/guide"
        onClick={() => trackEvent('links_guide')}
        className="block rounded-sm bg-bone-warm border border-dust text-charcoal p-4 text-center transition-base hover:bg-bone-deep"
      >
        <span className="block font-medium text-[15px]">
          <IconBook />
          free guide: the real cost of a half cow
        </span>
        <span className="block text-[13px] mt-1 text-saddle">
          the honest math — price per pound, freezer space, what you actually get
        </span>
      </Link>

      {/* ── rung 6: gear + merch, one compact row ── */}
      <div className="grid grid-cols-2 gap-3">
        <Link
          href="/gear"
          onClick={() => trackEvent('links_gear')}
          className="block rounded-sm bg-bone-warm border border-dust text-charcoal px-3 py-3.5 text-center transition-base hover:bg-bone-deep"
        >
          <span className="block font-medium text-[14px]">the gear</span>
          <span className="block text-xs mt-0.5 text-saddle">freezers · grills · knives</span>
        </Link>
        <a
          href="https://merch.buyhalfcow.com?utm_source=buyhalfcow&utm_medium=links&utm_campaign=bio-hub"
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => trackEvent('links_merch')}
          className="block rounded-sm bg-bone-warm border border-dust text-charcoal px-3 py-3.5 text-center transition-base hover:bg-bone-deep"
        >
          <span className="block font-medium text-[14px]">
            <IconCap />
            the merch
          </span>
          <span className="block text-xs mt-0.5 text-saddle">hats &amp; tees</span>
        </a>
      </div>
    </div>
  );
}
