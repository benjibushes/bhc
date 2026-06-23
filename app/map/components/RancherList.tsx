import type { MapPin } from '../page';
import { fromPriceLabel, locationLabel } from './priceLabel';

// Server-rendered, crawlable directory of ranchers. This exists so Google sees
// real content + real links to /ranchers/{slug} — the Leaflet map is ssr:false,
// so without this the page would index as an empty <div>. Doubles as a
// mobile-friendly scan mode behind the list/map toggle.
//
// We surface the buyer-actionable set (verified + onboarding) by default —
// verified first (shipping today), then onboarding (coming soon). Prospects and
// self-submitted ranchers are intentionally excluded from the SEO list: they
// aren't routable and a thin "unclaimed" entry is low-quality for indexing.
// The map itself still shows them (with their own filter).

function rank(status: MapPin['status']): number {
  if (status === 'verified') return 0;
  if (status === 'onboarding') return 1;
  return 2;
}

export default function RancherList({ pins }: { pins: MapPin[] }) {
  const listed = pins
    .filter((p) => p.status === 'verified' || p.status === 'onboarding')
    .filter((p) => p.slug) // only ranchers with a real page to link to
    .sort((a, b) => {
      const r = rank(a.status) - rank(b.status);
      if (r !== 0) return r;
      const s = a.state.localeCompare(b.state);
      if (s !== 0) return s;
      return a.ranchName.localeCompare(b.ranchName);
    });

  if (listed.length === 0) {
    return (
      <p className="text-sm text-saddle">
        No verified ranchers listed yet — check back soon, or{' '}
        <a href="/access" className="underline hover:text-charcoal">
          get on the waitlist
        </a>
        .
      </p>
    );
  }

  return (
    <ul className="divide-y divide-divider/10 border border-dust">
      {listed.map((p) => {
        const price = fromPriceLabel(p);
        const loc = locationLabel(p);
        return (
          <li key={p.id}>
            <a
              href={`/ranchers/${p.slug}`}
              className="flex items-center gap-3 px-4 py-3 transition-base hover:bg-bone-warm"
            >
              {/* Logo thumbnail — falls back to a monogram tile when absent so
                  rows never collapse / show a broken-image icon. */}
              {p.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.logoUrl}
                  alt=""
                  width={40}
                  height={40}
                  loading="lazy"
                  className="w-10 h-10 rounded object-cover bg-bone-deep shrink-0"
                />
              ) : (
                <span
                  aria-hidden
                  className="w-10 h-10 rounded bg-bone-deep text-saddle shrink-0 flex items-center justify-center text-sm font-serif"
                >
                  {p.ranchName.charAt(0).toUpperCase()}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-medium text-charcoal truncate">{p.ranchName}</span>
                  {p.status === 'verified' ? (
                    <span className="text-[11px] uppercase tracking-wide text-sage shrink-0">
                      verified
                    </span>
                  ) : (
                    <span className="text-[11px] uppercase tracking-wide text-rust-dark shrink-0">
                      onboarding
                    </span>
                  )}
                </span>
                <span className="block text-xs text-saddle truncate">
                  {loc}
                  {loc && (price || p.primaryProduct) ? ' · ' : ''}
                  {price || p.primaryProduct}
                </span>
              </span>
              <span aria-hidden className="text-dust text-sm shrink-0">
                →
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
