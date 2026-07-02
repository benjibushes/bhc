'use client';

import { useEffect, useState } from 'react';

// Live counter — fetches network stats on mount, animates count-up. Drops
// on homepage hero, /map header, /founders header. Replaces "10,000+ families"
// vanity numbers with whatever's actually true right now.
//
// Stats source: /api/stats/public (revalidated every 10 min server-side).
// Component caches in memory for the session so multiple instances don't
// hammer the endpoint.

export type Stats = {
  buyers: number;
  ranchers: number;
  states: number;
  closedDeals?: number;
  gmv?: number;
};

let cachedStats: Stats | null = null;
let cachedAt = 0;
const CACHE_MS = 60_000; // 60 sec — counter feels live without thrashing

async function fetchStats(): Promise<Stats | null> {
  const now = Date.now();
  if (cachedStats && now - cachedAt < CACHE_MS) return cachedStats;
  try {
    const res = await fetch('/api/stats/public', { cache: 'no-store' });
    if (!res.ok) return cachedStats; // fall back to last-known on error
    const data = await res.json();
    // Prefer verified counts when available — never claim ranchers we
    // can't deliver. Falls back to total counts for backwards compat.
    const stats: Stats = {
      buyers: Number(data.beefBuyerCount || data.buyerCount || data.buyers || 0),
      ranchers: Number(data.verifiedRancherCount || data.rancherCount || data.ranchers || 0),
      states: Number(data.verifiedStateCount || data.stateCount || data.states || 0),
      closedDeals: data.closedDeals != null ? Number(data.closedDeals) : undefined,
      gmv: data.gmv != null ? Number(data.gmv) : undefined,
    };
    cachedStats = stats;
    cachedAt = now;
    return stats;
  } catch {
    return cachedStats;
  }
}

// Shared stats hook — one module-level cache feeds every consumer on the
// page (hero headline + LiveCounter used to fire two separate fetches of
// the same endpoint on homepage mount).
export function useNetworkStats(): Stats | null {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchStats().then((s) => {
      if (!cancelled && s) setStats(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return stats;
}

// Count-up animation — eases from 0 to target over ~1s on first paint.
// Skips animation if user prefers reduced motion.
function useAnimatedCount(target: number, durationMs = 900): number {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (target <= 0) {
      setVal(0);
      return;
    }
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setVal(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs);
      // Ease-out cubic — quick ramp, smooth land
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return val;
}

interface LiveCounterProps {
  variant?: 'default' | 'inverted';
  showStates?: boolean;
}

export default function LiveCounter({ variant = 'default', showStates = true }: LiveCounterProps) {
  const stats = useNetworkStats();

  const buyers = useAnimatedCount(stats?.buyers || 0);
  const ranchers = useAnimatedCount(stats?.ranchers || 0);
  const states = useAnimatedCount(stats?.states || 0);

  const labelClass =
    variant === 'inverted'
      ? 'text-xs uppercase tracking-wider text-bone/70'
      : 'text-xs uppercase tracking-wider text-saddle';
  const valueClass =
    variant === 'inverted'
      ? 'font-serif text-3xl md:text-4xl text-bone'
      : 'font-serif text-3xl md:text-4xl text-charcoal';
  const dividerClass = variant === 'inverted' ? 'bg-bone/30' : 'bg-dust';

  // Invisible (not unmounted) until stats land — the row keeps its height
  // so there's no layout shift, and buyers never see a "0 Members" flash
  // while the fetch is in flight (or stuck).
  return (
    <div
      className={`flex justify-center gap-6 md:gap-10 pt-2 transition-opacity duration-300 ${
        stats ? 'opacity-100' : 'opacity-0'
      }`}
      aria-hidden={!stats}
    >
      <div className="text-center">
        <div className={valueClass}>{buyers.toLocaleString()}</div>
        <div className={labelClass}>{buyers === 1 ? 'Member' : 'Members'}</div>
      </div>
      <div className={`w-px ${dividerClass}`} />
      <div className="text-center">
        <div className={valueClass}>{ranchers.toLocaleString()}</div>
        <div className={labelClass}>{ranchers === 1 ? 'Rancher' : 'Ranchers'}</div>
      </div>
      {showStates && (
        <>
          <div className={`w-px ${dividerClass}`} />
          <div className="text-center">
            <div className={valueClass}>{states}</div>
            <div className={labelClass}>{states === 1 ? 'State' : 'States'}</div>
          </div>
        </>
      )}
    </div>
  );
}
