'use client';

import { useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MapPin } from '../page';
import MapLegend from './MapLegend';
import StateFilter from './StateFilter';
import ProductFilter from './ProductFilter';

// Inline SVG pin icons. We deliberately avoid bundling the default Leaflet
// raster icon — Next.js bundles assets oddly and 404 the marker shadow PNG.
// Three visual states:
//   - Solid green     → verified partner
//   - Solid yellow    → self-submitted / community-submitted (raised their hand)
//   - Dashed grey     → cold-discovered prospect
const verifiedIconSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
  <path d="M14 1 C7 1 1.5 6.5 1.5 13.5 C1.5 23 14 35 14 35 C14 35 26.5 23 26.5 13.5 C26.5 6.5 21 1 14 1 Z"
        fill="#4F7A3F" stroke="#2A4A20" stroke-width="1.5"/>
  <circle cx="14" cy="13" r="4.5" fill="#F4F1EC"/>
</svg>`;

const selfSubmittedIconSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
  <path d="M14 1 C7 1 1.5 6.5 1.5 13.5 C1.5 23 14 35 14 35 C14 35 26.5 23 26.5 13.5 C26.5 6.5 21 1 14 1 Z"
        fill="#E8C547" stroke="#8A6F1A" stroke-width="1.5"/>
  <circle cx="14" cy="13" r="4.5" fill="#0E0E0E"/>
</svg>`;

const prospectIconSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
  <path d="M14 1 C7 1 1.5 6.5 1.5 13.5 C1.5 23 14 35 14 35 C14 35 26.5 23 26.5 13.5 C26.5 6.5 21 1 14 1 Z"
        fill="#A7A29A" stroke="#0E0E0E" stroke-width="1.5"
        stroke-dasharray="3 2"/>
  <circle cx="14" cy="13" r="4.5" fill="#F4F1EC"/>
</svg>`;

function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${typeof window !== 'undefined' ? btoa(svg) : Buffer.from(svg).toString('base64')}`;
}

const verifiedIcon = L.icon({
  iconUrl: svgToDataUri(verifiedIconSvg),
  iconSize: [28, 36],
  iconAnchor: [14, 35],
  popupAnchor: [0, -32],
});

const selfSubmittedIcon = L.icon({
  iconUrl: svgToDataUri(selfSubmittedIconSvg),
  iconSize: [28, 36],
  iconAnchor: [14, 35],
  popupAnchor: [0, -32],
});

const prospectIcon = L.icon({
  iconUrl: svgToDataUri(prospectIconSvg),
  iconSize: [28, 36],
  iconAnchor: [14, 35],
  popupAnchor: [0, -32],
});

function iconForStatus(status: MapPin['status']) {
  if (status === 'verified') return verifiedIcon;
  if (status === 'self-submitted') return selfSubmittedIcon;
  return prospectIcon;
}

// Continental US starting view. Just-clear-of-edges so AK/HI ranchers still
// fit if they show up (rare but possible).
const DEFAULT_CENTER: [number, number] = [39.5, -98.35];
const DEFAULT_ZOOM = 4;

export default function DiscoverMap({ pins }: { pins: MapPin[] }) {
  const [stateFilter, setStateFilter] = useState<string>('');
  const [productFilter, setProductFilter] = useState<string>('');

  const states = useMemo(() => {
    const set = new Set<string>();
    for (const p of pins) if (p.state) set.add(p.state);
    return Array.from(set).sort();
  }, [pins]);

  const products = useMemo(() => {
    const set = new Set<string>();
    for (const p of pins) if (p.primaryProduct) set.add(p.primaryProduct);
    return Array.from(set).sort();
  }, [pins]);

  const filtered = useMemo(() => {
    return pins.filter((p) => {
      if (stateFilter && p.state !== stateFilter) return false;
      if (productFilter && p.primaryProduct !== productFilter) return false;
      return true;
    });
  }, [pins, stateFilter, productFilter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div className="flex flex-wrap gap-3 items-center">
          <StateFilter value={stateFilter} options={states} onChange={setStateFilter} />
          <ProductFilter value={productFilter} options={products} onChange={setProductFilter} />
          {(stateFilter || productFilter) && (
            <button
              type="button"
              onClick={() => {
                setStateFilter('');
                setProductFilter('');
              }}
              className="text-xs underline text-[#6B4F3F] hover:text-[#0E0E0E]"
            >
              Clear filters
            </button>
          )}
        </div>
        <p className="text-xs text-[#A7A29A]">
          Showing {filtered.length} of {pins.length}
        </p>
      </div>

      <div className="border border-[#A7A29A] overflow-hidden h-[420px] md:h-[600px]">
        <MapContainer
          center={DEFAULT_CENTER}
          zoom={DEFAULT_ZOOM}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {filtered.map((p) => (
            <Marker
              key={p.id}
              position={[p.lat, p.lng]}
              icon={iconForStatus(p.status)}
            >
              <Popup>
                <div style={{ minWidth: 180 }}>
                  <p style={{ fontWeight: 700, margin: 0 }}>{p.ranchName}</p>
                  <p style={{ margin: '4px 0', fontSize: 12, color: '#6B4F3F' }}>
                    {p.state}
                    {p.primaryProduct ? ` · ${p.primaryProduct}` : ''}
                  </p>
                  <p style={{ margin: '4px 0', fontSize: 12 }}>
                    {p.status === 'verified' && (
                      <span style={{ color: '#4F7A3F', fontWeight: 600 }}>
                        Verified partner
                      </span>
                    )}
                    {p.status === 'self-submitted' && (
                      <span style={{ color: '#8A6F1A', fontWeight: 600 }}>
                        On the map · onboarding pending
                      </span>
                    )}
                    {p.status === 'prospect' && (
                      <span style={{ color: '#6B4F3F' }}>Prospect (unclaimed)</span>
                    )}
                  </p>
                  {p.slug && (
                    <a
                      href={`/ranchers/${p.slug}`}
                      style={{
                        display: 'inline-block',
                        marginTop: 6,
                        fontSize: 12,
                        color: '#0E0E0E',
                        textDecoration: 'underline',
                      }}
                    >
                      {p.status === 'verified' ? 'View ranch →' : 'View / claim →'}
                    </a>
                  )}
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

      <MapLegend />
    </div>
  );
}
