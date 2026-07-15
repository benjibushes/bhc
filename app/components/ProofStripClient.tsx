'use client';

// ProofStripClient — the social-proof strip for 'use client' pages (the
// deposit checkout). Fetches aggregates from /api/social-proof after mount;
// renders NOTHING until real data arrives and nothing at all on any failure
// (silent — a proof strip must never add an error state to a checkout).

import { useEffect, useState } from 'react';
import ProofStripView, { type ProofStripData } from './ProofStripView';

export default function ProofStripClient({
  className = '',
  linkToWins = true,
}: {
  className?: string;
  linkToWins?: boolean;
}) {
  const [data, setData] = useState<ProofStripData | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/social-proof')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j || !(Number(j.deals) > 0)) return;
        setData({
          deals: Number(j.deals),
          gmvLabel: String(j.gmvLabel || ''),
          latestWinLabel: j.latestWinLabel ? String(j.latestWinLabel) : null,
        });
      })
      .catch(() => {
        /* silent — strip simply doesn't render */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!data) return null;
  return <ProofStripView data={data} className={className} linkToWins={linkToWins} />;
}
