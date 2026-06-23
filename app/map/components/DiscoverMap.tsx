'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
// react-leaflet-cluster bundles the JS (leaflet.markercluster) but NOT its CSS,
// so we import the cluster-bubble styles explicitly — otherwise clusters render
// as unstyled boxes. These ship inside the package's dist/assets.
import 'react-leaflet-cluster/dist/assets/MarkerCluster.css';
import 'react-leaflet-cluster/dist/assets/MarkerCluster.Default.css';
import type { MapPin } from '../page';
import MapLegend from './MapLegend';
import StateFilter from './StateFilter';
import ProductFilter from './ProductFilter';
import StatusFilter, { statusMatches, type StatusFilterValue } from './StatusFilter';
import UncoveredStateCapture from './UncoveredStateCapture';
import { fromPriceLabel, locationLabel } from './priceLabel';

// Inline SVG pin icons. We deliberately avoid bundling the default Leaflet
// raster icon — Next.js bundles assets oddly and 404 the marker shadow PNG.
// Four visual states aligned to onboarding pipeline:
//   - Solid green   → verified partner (Verification=Verified + Onboarding=Live)
//   - Solid orange  → in-progress onboarding (Call/Docs/Agreement/Verification stages)
//   - Solid yellow  → self-submitted / community-flagged (raised their hand)
//   - Dashed grey   → cold-discovered prospect
const verifiedIconSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
  <path d="M14 1 C7 1 1.5 6.5 1.5 13.5 C1.5 23 14 35 14 35 C14 35 26.5 23 26.5 13.5 C26.5 6.5 21 1 14 1 Z"
        fill="#4F7A3F" stroke="#2A4A20" stroke-width="1.5"/>
  <circle cx="14" cy="13" r="4.5" fill="#F4F1EC"/>
</svg>`;

// Onboarding pin — solid orange, paper-warm border. Distinct from yellow
// (raised-hand-only) and grey (cold). Signals active progress in pipeline.
const onboardingIconSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
  <path d="M14 1 C7 1 1.5 6.5 1.5 13.5 C1.5 23 14 35 14 35 C14 35 26.5 23 26.5 13.5 C26.5 6.5 21 1 14 1 Z"
        fill="#D97757" stroke="#8C3D1F" stroke-width="1.5"/>
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

const onboardingIcon = L.icon({
  iconUrl: svgToDataUri(onboardingIconSvg),
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
  if (status === 'onboarding') return onboardingIcon;
  if (status === 'self-submitted') return selfSubmittedIcon;
  return prospectIcon;
}

// Continental US starting view. Just-clear-of-edges so AK/HI ranchers still
// fit if they show up (rare but possible).
const DEFAULT_CENTER: [number, number] = [39.5, -98.35];
const DEFAULT_ZOOM = 4;

// ── Imperative map controllers (must live inside <MapContainer>) ────────────

// Frames the map to the currently-filtered pins whenever the set changes, so
// filtering to "TX" zooms into Texas instead of leaving the user staring at the
// whole country. Skips the very first render (we keep the nice US overview) and
// no-ops on an empty set.
function FitToPins({ pins, signal }: { pins: MapPin[]; signal: string }) {
  const map = useMap();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (pins.length === 0) return;
    if (pins.length === 1) {
      map.flyTo([pins[0].lat, pins[0].lng], 9, { duration: 0.6 });
      return;
    }
    const bounds = L.latLngBounds(pins.map((p) => [p.lat, p.lng] as [number, number]));
    map.flyToBounds(bounds, { padding: [48, 48], maxZoom: 10, duration: 0.6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal]);
  return null;
}

// Holds a handle to the live map so the parent's "near me" button can fly to a
// geolocated point. Exposed via a ref callback rather than lifting the whole
// map instance into parent state (which would thrash on every render).
function MapHandle({ onReady }: { onReady: (map: L.Map) => void }) {
  const map = useMap();
  useEffect(() => {
    onReady(map);
  }, [map, onReady]);
  return null;
}

function haversine(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(h));
}

export default function DiscoverMap({ pins }: { pins: MapPin[] }) {
  // ── Filter state, hydrated from the URL for shareable/SEO links ──────────
  const initial = useMemo(() => {
    if (typeof window === 'undefined') return { state: '', product: '', status: 'coming' as StatusFilterValue };
    const sp = new URLSearchParams(window.location.search);
    const rawStatus = (sp.get('status') || '').toLowerCase();
    const status: StatusFilterValue =
      rawStatus === 'available' || rawStatus === 'verified'
        ? 'available'
        : rawStatus === 'all'
          ? 'all'
          : 'coming';
    return {
      state: (sp.get('state') || '').toUpperCase(),
      product: sp.get('product') || '',
      status,
    };
  }, []);

  const [stateFilter, setStateFilter] = useState<string>(initial.state);
  const [productFilter, setProductFilter] = useState<string>(initial.product);
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>(initial.status);
  const [geoMsg, setGeoMsg] = useState<string>('');
  const [geoBusy, setGeoBusy] = useState(false);

  const mapRef = useRef<L.Map | null>(null);
  // Marker refs keyed by pin id so geolocation can open the nearest popup.
  const markerRefs = useRef<Record<string, L.Marker | null>>({});

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
      if (!statusMatches(statusFilter, p.status)) return false;
      if (stateFilter && p.state !== stateFilter) return false;
      if (productFilter && p.primaryProduct !== productFilter) return false;
      return true;
    });
  }, [pins, stateFilter, productFilter, statusFilter]);

  // Whether the *state* the visitor picked has ANY plottable pin at all
  // (independent of the status/product filters). Drives the uncovered-state
  // capture card: we only call a state "uncovered" when there's genuinely
  // nobody there, not merely filtered out.
  const stateHasAnyPin = useMemo(() => {
    if (!stateFilter) return true;
    return pins.some((p) => p.state === stateFilter);
  }, [pins, stateFilter]);

  // ── URL sync — keep ?state=&product=&status= in the address bar so a
  // filtered view is shareable + crawlable. replaceState (no history spam).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    if (stateFilter) sp.set('state', stateFilter); else sp.delete('state');
    if (productFilter) sp.set('product', productFilter); else sp.delete('product');
    // 'coming' is the default — omit it from the URL so the canonical /map URL
    // stays clean and only non-default filters appear.
    if (statusFilter !== 'coming') sp.set('status', statusFilter); else sp.delete('status');
    const qs = sp.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    window.history.replaceState(null, '', next);
  }, [stateFilter, productFilter, statusFilter]);

  // Signal string that changes whenever the filtered set's framing should
  // change. Feeds FitToPins so it reframes on any filter change.
  const fitSignal = `${stateFilter}|${productFilter}|${statusFilter}|${filtered.length}`;

  const handleMapReady = useCallback((map: L.Map) => {
    mapRef.current = map;
  }, []);

  // ── "Find ranchers near me" ─────────────────────────────────────────────
  // Geolocate → fly to the user → open the nearest VERIFIED pin's popup so the
  // first thing they see is a card they can act on. Falls back gracefully: no
  // geolocation API, permission denied, or no verified pins each get a clear,
  // non-blocking message instead of a silent failure.
  const findNearMe = useCallback(() => {
    setGeoMsg('');
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeoMsg('Location isn’t available on this device — pick your state above instead.');
      return;
    }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoBusy(false);
        const me: [number, number] = [pos.coords.latitude, pos.coords.longitude];
        const map = mapRef.current;
        if (!map) return;

        // Nearest verified pin (the only routable, shipping-today set). If
        // none are verified, fall back to the nearest of anyone shown.
        const verified = pins.filter((p) => p.status === 'verified');
        const pool = verified.length > 0 ? verified : filtered;
        if (pool.length === 0) {
          map.flyTo(me, 7, { duration: 0.8 });
          setGeoMsg('No ranchers near you yet — drop your email below and we’ll scout your area.');
          return;
        }
        let nearest = pool[0];
        let best = Infinity;
        for (const p of pool) {
          const d = haversine(me, [p.lat, p.lng]);
          if (d < best) {
            best = d;
            nearest = p;
          }
        }
        // Make sure the nearest pin passes the active filter so its marker is
        // actually mounted; if not, relax the status filter to reveal it.
        if (!statusMatches(statusFilter, nearest.status)) {
          setStatusFilter('all');
        }
        map.flyTo([nearest.lat, nearest.lng], 8, { duration: 0.9 });
        // Open the popup once the fly settles + the marker has mounted.
        window.setTimeout(() => {
          markerRefs.current[nearest.id]?.openPopup();
        }, 950);
      },
      (err) => {
        setGeoBusy(false);
        if (err.code === err.PERMISSION_DENIED) {
          setGeoMsg('Location blocked — no worries, pick your state from the dropdown above.');
        } else {
          setGeoMsg('Couldn’t get your location — pick your state above instead.');
        }
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  }, [pins, filtered, statusFilter]);

  const clearable = stateFilter || productFilter || statusFilter !== 'coming';

  return (
    <div className="space-y-4">
      {/* Controls row — filters left, near-me right */}
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div className="flex flex-wrap gap-3 items-center">
          <StatusFilter value={statusFilter} onChange={setStatusFilter} />
          <StateFilter value={stateFilter} options={states} onChange={setStateFilter} />
          <ProductFilter value={productFilter} options={products} onChange={setProductFilter} />
          {clearable && (
            <button
              type="button"
              onClick={() => {
                setStateFilter('');
                setProductFilter('');
                setStatusFilter('coming');
              }}
              className="text-xs underline text-saddle hover:text-charcoal"
            >
              Clear filters
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={findNearMe}
          disabled={geoBusy}
          className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide px-3 py-2 border border-charcoal text-charcoal transition-base hover:bg-charcoal hover:text-bone disabled:opacity-60"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="12" cy="10" r="3" />
            <path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11z" />
          </svg>
          {geoBusy ? 'Locating…' : 'Find ranchers near me'}
        </button>
      </div>

      <p className="text-xs text-dust">
        Showing {filtered.length} of {pins.length}
        {geoMsg ? <span className="text-saddle"> · {geoMsg}</span> : null}
      </p>

      {/* Uncovered-state capture — only when the chosen state genuinely has no
          pins (independent of status/product filters). Turns a dead-end filter
          into a captured lead. */}
      {stateFilter && !stateHasAnyPin && (
        <UncoveredStateCapture state={stateFilter} />
      )}

      <div className="border border-dust overflow-hidden h-[420px] md:h-[600px]">
        <MapContainer
          center={DEFAULT_CENTER}
          zoom={DEFAULT_ZOOM}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom={false}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MapHandle onReady={handleMapReady} />
          <FitToPins pins={filtered} signal={fitSignal} />
          <MarkerClusterGroup chunkedLoading maxClusterRadius={45}>
            {filtered.map((p) => (
              <Marker
                key={p.id}
                position={[p.lat, p.lng]}
                icon={iconForStatus(p.status)}
                ref={(m) => {
                  markerRefs.current[p.id] = m;
                }}
              >
                <Popup>
                  <PinCard pin={p} />
                </Popup>
              </Marker>
            ))}
          </MarkerClusterGroup>
        </MapContainer>
      </div>

      <MapLegend />
    </div>
  );
}

// ── Rich pin card ───────────────────────────────────────────────────────────
// Replaces the old underlined text link with a real storefront card: logo,
// name, location, "from $X/half", a status line, and a tap-friendly primary
// button. Verified pins get a filled "Reserve" CTA; non-verified get a softer
// "View ranch" so we never promise checkout on a rancher who can't fulfill yet.
function PinCard({ pin }: { pin: MapPin }) {
  const price = pin.status === 'verified' ? fromPriceLabel(pin) : '';
  const loc = locationLabel(pin);
  const reserve = pin.status === 'verified';

  return (
    <div style={{ minWidth: 210, maxWidth: 240 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {pin.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={pin.logoUrl}
            alt=""
            width={44}
            height={44}
            style={{ width: 44, height: 44, borderRadius: 6, objectFit: 'cover', background: '#E5E2DC', flexShrink: 0 }}
          />
        ) : (
          <span
            aria-hidden
            style={{
              width: 44, height: 44, borderRadius: 6, background: '#E5E2DC', color: '#6B4F3F',
              flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'Georgia, serif', fontSize: 18,
            }}
          >
            {pin.ranchName.charAt(0).toUpperCase()}
          </span>
        )}
        <div style={{ minWidth: 0 }}>
          <p style={{ fontWeight: 700, margin: 0, fontSize: 14, lineHeight: 1.2, color: '#0E0E0E' }}>
            {pin.ranchName}
          </p>
          {loc ? (
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6B4F3F' }}>{loc}</p>
          ) : null}
        </div>
      </div>

      {price ? (
        <p style={{ margin: '8px 0 0', fontSize: 15, fontWeight: 700, color: '#0E0E0E' }}>{price}</p>
      ) : null}

      <p style={{ margin: '6px 0 0', fontSize: 12 }}>
        {pin.status === 'verified' && (
          <span style={{ color: '#4F7A3F', fontWeight: 600 }}>● Verified · shipping today</span>
        )}
        {pin.status === 'onboarding' && (
          <span style={{ color: '#8C3D1F', fontWeight: 600 }}>
            ● Onboarding{pin.stageLabel ? ` · ${pin.stageLabel}` : ''}
          </span>
        )}
        {pin.status === 'self-submitted' && (
          <span style={{ color: '#8A6F1A', fontWeight: 600 }}>● On the map · onboarding pending</span>
        )}
        {pin.status === 'prospect' && (
          <span style={{ color: '#6B4F3F' }}>○ Prospect (unclaimed)</span>
        )}
      </p>

      {pin.slug && (
        <a
          href={`/ranchers/${pin.slug}`}
          style={{
            display: 'block',
            marginTop: 10,
            textAlign: 'center',
            padding: '9px 12px',
            fontSize: 13,
            fontWeight: 600,
            textDecoration: 'none',
            borderRadius: 2,
            ...(reserve
              ? { background: '#0E0E0E', color: '#F4F1EC' }
              : { background: 'transparent', color: '#0E0E0E', border: '1.5px solid #0E0E0E' }),
          }}
        >
          {reserve ? 'Reserve →' : 'View ranch →'}
        </a>
      )}
    </div>
  );
}
