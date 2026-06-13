'use client';

// Client-only wrapper. Next.js 16 (Turbopack) forbids `dynamic({ ssr: false })`
// from a Server Component, so we hop into a Client Component here and let it
// dynamically import the Leaflet-bound map module.
//
// Why dynamic at all: react-leaflet touches `window` at module load, so any
// SSR rendering crashes. Loading via `dynamic({ ssr: false })` from inside a
// Client Component is the supported pattern.

import dynamic from 'next/dynamic';
import type { MapPin } from '../page';

const DiscoverMap = dynamic(() => import('./DiscoverMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[600px] flex items-center justify-center bg-[#FAF8F4] border border-dust">
      <p className="text-sm text-dust">Loading map…</p>
    </div>
  ),
});

export default function DiscoverMapClient({ pins }: { pins: MapPin[] }) {
  return <DiscoverMap pins={pins} />;
}
