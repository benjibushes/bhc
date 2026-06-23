'use client';

// Client-only wrapper. Next.js 16 (Turbopack) forbids `dynamic({ ssr: false })`
// from a Server Component, so we hop into a Client Component here and let it
// dynamically import the Leaflet-bound map module.
//
// Why dynamic at all: react-leaflet touches `window` at module load, so any
// SSR rendering crashes. Loading via `dynamic({ ssr: false })` from inside a
// Client Component is the supported pattern.
//
// This shell ALSO owns the list/map view toggle. Critically, the toggle +
// `{listSlot}` live HERE (not inside the ssr:false map module), so the
// server-rendered rancher list is part of the initial HTML — Google indexes
// real content + /ranchers/{slug} links even though the map itself is
// client-only. In map view the list is just visually hidden (still in the DOM
// and crawlable); in list view the heavy map stays mounted but hidden so
// toggling back is instant.

import dynamic from 'next/dynamic';
import { useState, type ReactNode } from 'react';
import type { MapPin } from '../page';

const DiscoverMap = dynamic(() => import('./DiscoverMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[420px] md:h-[600px] flex items-center justify-center bg-[#FAF8F4] border border-dust">
      <p className="text-sm text-dust">Loading map…</p>
    </div>
  ),
});

export default function DiscoverMapClient({
  pins,
  listSlot,
}: {
  pins: MapPin[];
  listSlot?: ReactNode;
}) {
  const [view, setView] = useState<'map' | 'list'>('map');

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <div className="inline-flex border border-dust text-xs" role="group" aria-label="View">
          <button
            type="button"
            onClick={() => setView('map')}
            aria-pressed={view === 'map'}
            className={`px-4 py-2 transition-base ${view === 'map' ? 'bg-charcoal text-bone' : 'text-saddle hover:text-charcoal'}`}
          >
            Map
          </button>
          <button
            type="button"
            onClick={() => setView('list')}
            aria-pressed={view === 'list'}
            className={`px-4 py-2 transition-base ${view === 'list' ? 'bg-charcoal text-bone' : 'text-saddle hover:text-charcoal'}`}
          >
            List
          </button>
        </div>
      </div>

      {/* Map stays mounted (just hidden) in list view so re-toggling is instant
          and Leaflet doesn't re-initialize. */}
      <div className={view === 'map' ? 'block' : 'hidden'}>
        <DiscoverMap pins={pins} />
      </div>

      {/* Server-rendered list — present in the SSR HTML for SEO regardless of
          which view is active. */}
      <div className={view === 'list' ? 'block' : 'hidden'}>{listSlot}</div>
    </div>
  );
}
