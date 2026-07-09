'use client';

// Bio-hub rungs — SHARES-FIRST (founder directive 2026-07-08, supersedes the
// shop-first default from the attention research: supply is activating and
// the share IS the business; the bio leads with it).
//
// Layout: one HERO card (the share reservation — serif, price-anchored,
// risk-reversed) → shop tripwire → find-a-ranch map → guide capture →
// gear+merch as a compact half-width pair. Every tap fires the same tracked
// events as before so the weekly read of which rung bio traffic takes stays
// continuous.
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
        <span className="block text-[11px] uppercase tracking-[0.2em] text-tallow mb-2">
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
        <span className="block text-[11.5px] mt-3 text-bone/55">
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
          🥩 not ready for a freezer-full? taste it first
        </span>
        <span className="block text-[12px] mt-1 text-saddle">
          jerky from $13.59 · boxes · ground — shipped nationwide from the same ranches
        </span>
      </Link>

      {/* ── rung 3: discovery — see who's near you ── */}
      <Link
        href="/map"
        onClick={() => trackEvent('links_map')}
        className="block rounded-sm bg-bone-warm border border-dust text-charcoal p-4 text-center transition-base hover:bg-bone-deep"
      >
        <span className="block font-medium text-[15px]">
          📍 find a verified ranch near you
        </span>
        <span className="block text-[12px] mt-1 text-saddle">
          browse the map — real family ranches, state by state
        </span>
      </Link>

      {/* ── rung 4: capture ── */}
      <Link
        href="/guide"
        onClick={() => trackEvent('links_guide')}
        className="block rounded-sm bg-bone-warm border border-dust text-charcoal p-4 text-center transition-base hover:bg-bone-deep"
      >
        <span className="block font-medium text-[15px]">
          📖 free guide: the real cost of a half cow
        </span>
        <span className="block text-[12px] mt-1 text-saddle">
          the honest math — price per pound, freezer space, what you actually get
        </span>
      </Link>

      {/* ── rung 5: gear + merch, one compact row ── */}
      <div className="grid grid-cols-2 gap-3">
        <Link
          href="/gear"
          onClick={() => trackEvent('links_gear')}
          className="block rounded-sm bg-bone-warm border border-dust text-charcoal px-3 py-3.5 text-center transition-base hover:bg-bone-deep"
        >
          <span className="block font-medium text-[14px]">the gear</span>
          <span className="block text-[11.5px] mt-0.5 text-saddle">freezers · grills · knives</span>
        </Link>
        <a
          href="https://merch.buyhalfcow.com?utm_source=buyhalfcow&utm_medium=links&utm_campaign=bio-hub"
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => trackEvent('links_merch')}
          className="block rounded-sm bg-bone-warm border border-dust text-charcoal px-3 py-3.5 text-center transition-base hover:bg-bone-deep"
        >
          <span className="block font-medium text-[14px]">🧢 the merch</span>
          <span className="block text-[11.5px] mt-0.5 text-saddle">hats &amp; tees from $20</span>
        </a>
      </div>
    </div>
  );
}
