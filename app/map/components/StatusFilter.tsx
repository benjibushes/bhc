'use client';

import type { MapPin } from '../page';

// Status filter — lets a buyer narrow to who they can actually act on instead
// of wading through cold prospects. Default (set in DiscoverMap) is 'coming'
// so the map leads with everyone reachable.
//
// Options map to a coarse availability axis rather than the raw 5-way status:
//   available → a GREEN pin (live or represented, #630 — hiding the
//               represented ranch that IS AZ's live supply would be its own
//               lie) that also has a real deposit rail, so the chip's promise
//               holds for every pin it leaves on the map.
//   coming    → every green pin plus onboarding. Membership is deliberately
//               status-only: five live ranches have no deposit rail but are
//               real, browsable supply, and the DEFAULT view must not hide
//               them.
//   all       → every plotted pin (incl. self-submitted + cold prospects)
//
// THE CHIPS (2026-08-18): these read "Shipping today" / "Shipping + onboarding"
// and neither was true — the bucket is onboarding progress, not logistics, and
// only four green ranches can ship a box at all. The labels now say what the
// buckets are, and `available` gained the depositReady arm so "Taking
// reservations" is true of every pin it shows.
export type StatusFilterValue = 'available' | 'coming' | 'all';

/** The two already-derived facts the filter reads off a pin. */
type FilterablePin = Pick<MapPin, 'status' | 'depositReady'>;

export function statusMatches(value: StatusFilterValue, pin: FilterablePin): boolean {
  const green = pin.status === 'live' || pin.status === 'represented';
  if (value === 'available') return green && pin.depositReady;
  if (value === 'coming') return green || pin.status === 'onboarding';
  return true;
}

// Rendered as toggle chips (not a <select>) inside the floating filter card —
// one tap on mobile, and the active choice is readable at a glance.
const OPTIONS: { value: StatusFilterValue; label: string }[] = [
  { value: 'coming', label: 'Live + onboarding' },
  { value: 'available', label: 'Taking reservations' },
  { value: 'all', label: 'Everyone' },
];

export default function StatusFilter({
  value,
  onChange,
}: {
  value: StatusFilterValue;
  onChange: (v: StatusFilterValue) => void;
}) {
  return (
    <div role="group" aria-label="Who to show" className="flex flex-wrap gap-1.5">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`border px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide transition-base ${
            value === o.value
              ? 'border-charcoal bg-charcoal text-bone'
              : 'border-dust bg-bone text-saddle hover:border-charcoal hover:text-charcoal'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
