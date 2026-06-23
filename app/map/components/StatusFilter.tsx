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

export default function StatusFilter({
  value,
  onChange,
}: {
  value: StatusFilterValue;
  onChange: (v: StatusFilterValue) => void;
}) {
  return (
    <label className="text-sm flex items-center gap-2">
      <span className="text-saddle">Show</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as StatusFilterValue)}
        className="px-3 py-2 border border-dust text-sm bg-bone text-charcoal"
      >
        <option value="coming">Shipping + onboarding</option>
        <option value="available">Shipping today only</option>
        <option value="all">Everyone on the map</option>
      </select>
    </label>
  );
}
