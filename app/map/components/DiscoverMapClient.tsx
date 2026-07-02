'use client';

// Client-only wrapper. Next.js 16 (Turbopack) forbids `dynamic({ ssr: false })`
// from a Server Component, so we hop into a Client Component here and let it
// dynamically import the Leaflet-bound map module.
//
// Why dynamic at all: react-leaflet touches `window` at module load, so any
// SSR rendering crashes. Loading via `dynamic({ ssr: false })` from inside a
// Client Component is the supported pattern.
//
// This shell is the IMMERSIVE HERO: a viewport-filling map with a slim on-map
// title bar, a compact always-visible legend, and the rancher list as a
// slide-in panel (side rail on desktop, full-width sheet on mobile).
//
// Everything that must reach the crawler renders HERE, not in the ssr:false
// map module: the <h1>, the coverage line, the legend, and `{listSlot}` (the
// server-rendered rancher <ul>). A 'use client' component still SSRs its
// initial HTML — only DiscoverMap itself skips the server. The list panel is
// merely translated off-canvas when closed (still in the DOM and crawlable);
// the heavy map stays mounted behind the open panel so toggling is instant.

import dynamic from 'next/dynamic';
import { useState, type ReactNode } from 'react';
import type { MapPin } from '../page';
import MapLegend from './MapLegend';

// Reserved hero height — identical classes on this wrapper, the dynamic-import
// placeholder, and loading.tsx's skeleton, so the map never causes layout
// shift: the box exists at full size before a single Leaflet byte arrives.
const HERO_HEIGHT = 'h-[68dvh] min-h-[460px] md:h-[78dvh] md:min-h-[560px]';

const DiscoverMap = dynamic(() => import('./DiscoverMap'), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center bg-[#EDE9E2]">
      <p className="text-sm text-saddle">Loading the map…</p>
    </div>
  ),
});

export default function DiscoverMapClient({
  pins,
  verifiedCount,
  statesCovered,
  listSlot,
}: {
  pins: MapPin[];
  verifiedCount: number;
  statesCovered: number;
  listSlot?: ReactNode;
}) {
  const [view, setView] = useState<'map' | 'list'>('map');

  return (
    <div className={`relative w-full overflow-hidden bg-[#EDE9E2] ${HERO_HEIGHT}`}>
      <DiscoverMap pins={pins} />

      {/* ── Slim on-map title bar ─────────────────────────────────────────────
          Fixed height (h-14 / md:h-16) — DiscoverMap's floating filter card
          positions itself below these exact constants. The h1 lives here so
          the page keeps a server-rendered heading over a client-only map. */}
      <header className="absolute inset-x-0 top-0 z-[1100] flex h-14 items-center gap-3 border-b border-dust/70 bg-bone/90 px-4 backdrop-blur-sm md:h-16 md:px-6">
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-serif text-base leading-tight lowercase md:text-xl">
            {verifiedCount > 0 ? (
              <>
                {verifiedCount} rancher{verifiedCount === 1 ? '' : 's'} shipping beef today
              </>
            ) : (
              <>every direct-to-consumer rancher in america</>
            )}
          </h1>
          <p className="hidden truncate text-[11px] text-saddle sm:block">
            {pins.length} ranch{pins.length === 1 ? '' : 'es'} across {statesCovered} state
            {statesCovered === 1 ? '' : 's'} — green pins are taking reservations
          </p>
        </div>
        <div className="inline-flex shrink-0 border border-dust bg-bone text-xs" role="group" aria-label="View">
          <button
            type="button"
            onClick={() => setView('map')}
            aria-pressed={view === 'map'}
            className={`px-3 py-1.5 transition-base md:px-4 md:py-2 ${
              view === 'map' ? 'bg-charcoal text-bone' : 'text-saddle hover:text-charcoal'
            }`}
          >
            Map
          </button>
          <button
            type="button"
            onClick={() => setView('list')}
            aria-pressed={view === 'list'}
            className={`px-3 py-1.5 transition-base md:px-4 md:py-2 ${
              view === 'list' ? 'bg-charcoal text-bone' : 'text-saddle hover:text-charcoal'
            }`}
          >
            List
          </button>
        </div>
      </header>

      {/* ── Compact legend — always visible, buyer language ──────────────────
          Bottom-left; lifted above the sticky mobile CTA (fixed, ~72px) the
          same way discover-map.css lifts Leaflet's bottom controls. */}
      <div className="pointer-events-none absolute left-3 bottom-[4.75rem] z-[1040] md:bottom-3">
        <MapLegend compact />
      </div>

      {/* ── Rancher list panel ───────────────────────────────────────────────
          Server-rendered markup (listSlot) that slides in from the right:
          side rail on desktop, full-width sheet under the title bar on
          mobile. `invisible` (not display:none) when closed keeps it out of
          the tab order / a11y tree while the HTML stays in the document for
          SEO — and lets the transform animate. */}
      <aside
        aria-label="Rancher list"
        className={`absolute inset-x-0 bottom-0 top-14 z-[1200] transition-[transform,visibility] duration-300 ease-out md:left-auto md:top-16 md:w-[420px] ${
          view === 'list' ? 'visible translate-x-0' : 'invisible translate-x-full'
        }`}
      >
        <div className="h-full overflow-y-auto overscroll-contain border-l border-dust bg-bone px-4 py-4 shadow-[-12px_0_32px_rgba(14,14,14,0.10)] md:px-5 md:py-5">
          <p className="mb-3 text-[11px] uppercase tracking-[0.18em] text-saddle">
            ranchers on the map
          </p>
          {listSlot}
        </div>
      </aside>
    </div>
  );
}
