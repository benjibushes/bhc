'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, ZoomControl, useMap } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
// react-leaflet-cluster bundles the JS (leaflet.markercluster) but NOT its CSS,
// so we import the cluster-bubble styles explicitly — otherwise clusters render
// as unstyled boxes. These ship inside the package's dist/assets.
import 'react-leaflet-cluster/dist/assets/MarkerCluster.css';
import 'react-leaflet-cluster/dist/assets/MarkerCluster.Default.css';
// Brand chrome — warm tile filter, divIcon pins, cluster bubbles, popup cards,
// control styling. Must come AFTER the cluster defaults so overrides win.
import './discover-map.css';
import type { MapPin } from '../page';
import StateFilter from './StateFilter';
import ProductFilter from './ProductFilter';
import StatusFilter, { statusMatches, type StatusFilterValue } from './StatusFilter';
import UncoveredStateCapture from './UncoveredStateCapture';
import { fromPriceLabel, locationLabel } from './priceLabel';

// Inline SVG pin bodies rendered through L.divIcon (not L.icon data-URIs) so
// CSS can drive hover/active states and the verified halo ring. We still avoid
// the default Leaflet raster icon — Next.js bundles assets oddly and 404s the
// marker shadow PNG. Visual language, aligned to the onboarding pipeline:
//   - Deep green pin + subtle ring → verified partner (taking reservations)
//   - Amber pin                    → in-progress onboarding
//   - Yellow pin                   → self-submitted / community-flagged
//   - Muted grey dot               → cold-discovered prospect (de-emphasized)
const verifiedIconSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
  <path d="M14 1 C7 1 1.5 6.5 1.5 13.5 C1.5 23 14 35 14 35 C14 35 26.5 23 26.5 13.5 C26.5 6.5 21 1 14 1 Z"
        fill="#4F7A3F" stroke="#2A4A20" stroke-width="1.5"/>
  <circle cx="14" cy="13" r="4.5" fill="#F4F1EC"/>
</svg>`;

// Onboarding pin — solid amber, paper-warm border. Distinct from yellow
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

// divIcon factory — className 'bhc-marker' replaces Leaflet's default
// .leaflet-div-icon (which would paint a white box behind the SVG). The
// verified pin gets a halo <span> BEFORE the svg so it paints underneath.
function pinDivIcon(svg: string, opts?: { halo?: boolean }) {
  return L.divIcon({
    className: 'bhc-marker',
    html: `<span class="bhc-pin">${opts?.halo ? '<span class="bhc-pin__halo"></span>' : ''}${svg}</span>`,
    iconSize: [28, 36],
    iconAnchor: [14, 35],
    popupAnchor: [0, -32],
  });
}

const verifiedIcon = pinDivIcon(verifiedIconSvg, { halo: true });
const onboardingIcon = pinDivIcon(onboardingIconSvg);
const selfSubmittedIcon = pinDivIcon(selfSubmittedIconSvg);

// Prospects render as a small muted dot — "on our radar", intentionally quiet
// next to the actionable teardrops.
const prospectIcon = L.divIcon({
  className: 'bhc-marker',
  html: '<span class="bhc-dot"></span>',
  iconSize: [11, 11],
  iconAnchor: [6, 6],
  popupAnchor: [0, -8],
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

// Immersive map surface. Renders inside DiscoverMapClient's viewport-height
// hero (absolute inset-0) with the filter controls as a floating card OVER the
// map instead of page chrome stacked above it. The slim title bar + list panel
// + legend live in DiscoverMapClient (they must be SSR'd; this module is
// ssr:false).
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
  // Mobile-only disclosure for the filter card body — closed by default so the
  // map owns the small screen. md+ ignores this (content always shown).
  const [filtersOpen, setFiltersOpen] = useState(false);

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
      setGeoMsg('Location isn’t available on this device — pick your state in the filters instead.');
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
          setGeoMsg('No ranchers near you yet — pick your state and drop your email so we can scout your area.');
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
          setGeoMsg('Location blocked — no worries, pick your state from the filters.');
        } else {
          setGeoMsg('Couldn’t get your location — pick your state in the filters instead.');
        }
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  }, [pins, filtered, statusFilter]);

  const clearable = stateFilter || productFilter || statusFilter !== 'coming';

  return (
    <div className="absolute inset-0">
      <MapContainer
        className="bhc-map"
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        style={{ height: '100%', width: '100%' }}
        scrollWheelZoom={false}
        zoomControl={false}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {/* Default topleft zoom would hide behind the floating filter card. */}
        <ZoomControl position="bottomright" />
        <MapHandle onReady={handleMapReady} />
        <FitToPins pins={filtered} signal={fitSignal} />
        <MarkerClusterGroup chunkedLoading maxClusterRadius={45} showCoverageOnHover={false}>
          {filtered.map((p) => (
            <Marker
              key={p.id}
              position={[p.lat, p.lng]}
              icon={iconForStatus(p.status)}
              riseOnHover
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

      {/* ── Floating filter card ─────────────────────────────────────────────
          Sits just under the slim title bar (h-14 mobile / h-16 desktop, both
          fixed heights, so the top offsets are safe constants). z-[1050] beats
          Leaflet's controls (1000) but stays under the title bar (1100) and
          list panel (1200). The wrapper is pointer-events-none so map drags
          pass through the empty column; each card re-enables events. */}
      <div className="pointer-events-none absolute left-3 right-3 top-16 z-[1050] space-y-2 md:right-auto md:top-[4.75rem] md:w-[368px]">
        <div className="pointer-events-auto border border-dust bg-bone/95 shadow-[0_10px_28px_rgba(14,14,14,0.14)] backdrop-blur-sm">
          <div className="flex items-center gap-2 px-3 py-2">
            <button
              type="button"
              onClick={() => setFiltersOpen((o) => !o)}
              aria-expanded={filtersOpen}
              aria-controls="map-filters"
              className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-charcoal md:hidden"
            >
              Filters
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                aria-hidden
                className={`transition-transform ${filtersOpen ? 'rotate-180' : ''}`}
              >
                <path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <span className="hidden text-[11px] font-medium uppercase tracking-wide text-charcoal md:inline">
              Filters
            </span>
            <span className="min-w-0 flex-1 truncate text-right text-[11px] text-saddle md:text-left">
              Showing {filtered.length} of {pins.length}
            </span>
            <button
              type="button"
              onClick={findNearMe}
              disabled={geoBusy}
              className="inline-flex shrink-0 items-center gap-1 border border-charcoal bg-bone px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-charcoal transition-base hover:bg-charcoal hover:text-bone disabled:opacity-60"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="12" cy="10" r="3" />
                <path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11z" />
              </svg>
              {geoBusy ? 'Locating…' : 'Near me'}
            </button>
          </div>
          <div
            id="map-filters"
            className={`${filtersOpen ? 'block' : 'hidden'} space-y-3 border-t border-dust/60 px-3 py-3 md:block`}
          >
            <StatusFilter value={statusFilter} onChange={setStatusFilter} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
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
                  className="text-[11px] text-saddle underline hover:text-charcoal"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Geolocation fallback messages — restyled as a quiet card instead of
            an inline text run. */}
        {geoMsg ? (
          <p
            role="status"
            className="pointer-events-auto border border-dust bg-bone/95 px-3 py-2 text-xs text-saddle shadow-sm backdrop-blur-sm"
          >
            {geoMsg}
          </p>
        ) : null}

        {/* Uncovered-state capture — only when the chosen state genuinely has
            no pins (independent of status/product filters). Turns a dead-end
            filter into a captured lead. */}
        {stateFilter && !stateHasAnyPin && (
          <div className="pointer-events-auto shadow-[0_10px_28px_rgba(14,14,14,0.14)]">
            <UncoveredStateCapture state={stateFilter} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Rich pin card ───────────────────────────────────────────────────────────
// Storefront-style card inside the Leaflet popup: logo, name, location,
// "from $X/half", a status line, and a tap-friendly primary button. Only
// DEPOSIT-READY ranchers (verified + onConnect) get the filled "Reserve" CTA;
// everyone else gets a softer "View ranch" so we never promise checkout on a
// rancher whose page can't actually take a deposit — that dead-ends the buyer
// at the checkout screen. A verified-but-not-Connect rancher is still real +
// browsable; the store lets buyers contact them there. Widths live in
// discover-map.css (.bhc-pin-card) so mobile can grow it into a big card.
function PinCard({ pin }: { pin: MapPin }) {
  const price = pin.status === 'verified' ? fromPriceLabel(pin) : '';
  const loc = locationLabel(pin);
  const reserve = pin.status === 'verified' && pin.onConnect;

  return (
    <div className="bhc-pin-card">
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
          <span style={{ color: '#4F7A3F', fontWeight: 600 }}>● Verified · taking reservations</span>
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
          <span style={{ color: '#6B4F3F' }}>○ On our radar (unclaimed)</span>
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
