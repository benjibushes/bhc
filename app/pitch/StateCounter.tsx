'use client';

// Live waiting-buyer counter for /pitch. Fetches the public
// buyers-by-state stat so the number a rancher sees on a call is the
// number that's true right now — RANCHER-PITCH.md rule: never invent
// numbers, and never quote stale ones. Renders nothing when no state is
// given or the fetch fails, so the page never shows a broken stat.

import { useEffect, useState } from 'react';

export default function StateCounter({ state }: { state?: string }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!state || state.length !== 2) return;
    let alive = true;
    fetch(`/api/stats/buyers-by-state?state=${encodeURIComponent(state)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.success && typeof d.count === 'number' && d.count > 0) {
          setCount(d.count);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [state]);

  if (!state || count === null) return null;

  return (
    <div className="inline-block border-2 border-rust bg-white px-6 py-4 text-center">
      <p className="font-serif text-4xl md:text-5xl text-charcoal leading-none">
        {count.toLocaleString()}
      </p>
      <p className="text-sm text-saddle mt-1 uppercase tracking-wider">
        families waiting on beef in {state.toUpperCase()}
      </p>
      <p className="text-xs text-saddle mt-1">live count, right now</p>
    </div>
  );
}
