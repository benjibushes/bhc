'use client';

import type { MapPin } from '../page';

// Status filter — lets a prospect narrow to "shipping today" (verified) instead
// of wading through cold prospects. Default (set in DiscoverMap) is
// verified+onboarding so the map leads with who you can actually reach.
//
// Options map to a coarse availability axis rather than the raw 4-way status:
//   available → verified (shipping today, routable)
//   coming    → verified + onboarding (shipping today or being onboarded)
//   all       → every plotted pin (incl. self-submitted + cold prospects)
export type StatusFilterValue = 'available' | 'coming' | 'all';

export function statusMatches(value: StatusFilterValue, status: MapPin['status']): boolean {
  if (value === 'available') return status === 'verified';
  if (value === 'coming') return status === 'verified' || status === 'onboarding';
  return true;
}

// Rendered as toggle chips (not a <select>) inside the floating filter card —
// one tap on mobile, and the active choice is readable at a glance.
const OPTIONS: { value: StatusFilterValue; label: string }[] = [
  { value: 'coming', label: 'Shipping + onboarding' },
  { value: 'available', label: 'Shipping today' },
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
