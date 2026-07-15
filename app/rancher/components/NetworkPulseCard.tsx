'use client';

// ── Network pulse card (dashboard UX upgrade, 2026-07-15) ──────────────────
// "The network this week" — makes the dashboard feel like part of a living
// marketplace, not a lonely admin panel. Read-only: one GET to the existing
// public /api/social-proof aggregates (lib/socialProof's 5-min-cached Closed
// Won rows — the same numbers the /wins page and buyer proof strips render).
//
// HONESTY RULES (inherited from lib/socialProof):
//   • Weekly line renders ONLY when the trailing 7 days had real closed
//     deals; a zero-week falls back to the all-time line. Never a dead zero.
//   • Any fetch failure or an empty network renders NOTHING — no lie, no
//     zero-claims, no console noise on the rancher's home screen.

import { useEffect, useState } from 'react';

interface PulsePayload {
  deals: number;
  gmvLabel?: string;
  weeklyDeals?: number;
  weeklyGmvLabel?: string;
}

export default function NetworkPulseCard() {
  const [pulse, setPulse] = useState<PulsePayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/social-proof');
        if (!res.ok) return;
        const data = (await res.json()) as PulsePayload;
        if (!cancelled && data && data.deals > 0) setPulse(data);
      } catch {
        /* render nothing — a proof card must never error at the rancher */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!pulse) return null;

  const weekly = (pulse.weeklyDeals || 0) > 0;
  const deals = weekly ? pulse.weeklyDeals! : pulse.deals;
  const gmvLabel = weekly ? pulse.weeklyGmvLabel || '' : pulse.gmvLabel || '';
  const dealsNoun = `deal${deals === 1 ? '' : 's'}`;

  return (
    <section
      aria-label="Network pulse"
      className="border border-dust bg-white p-5 rounded-sm"
    >
      <p className="text-[11px] uppercase tracking-widest text-saddle font-semibold">
        {weekly ? 'the network this week' : 'the network'}
      </p>
      <p className="font-serif text-lg text-charcoal mt-1">
        <span aria-hidden>🐂</span>{' '}
        {weekly ? (
          <>
            {deals} {dealsNoun} closed
            {gmvLabel ? <> · {gmvLabel} moved to ranchers</> : null}
          </>
        ) : (
          <>
            {deals} real {dealsNoun} closed
            {gmvLabel ? <> · {gmvLabel} moved to ranchers</> : null}
          </>
        )}
      </p>
      <p className="text-xs text-saddle mt-1">
        real buyers, real ranches — you&rsquo;re part of this.
      </p>
    </section>
  );
}
