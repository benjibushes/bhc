// ProofStrip — compact one-line social proof for server pages (/shop, the
// /half-a-cow/[state] SEO pages). Live Closed Won aggregates via
// lib/socialProof (5-min in-process cache; callers' page-level ISR handles
// CDN freshness — same layering as the /wins social-proof consumers).
//
// Renders NOTHING when data is unavailable or the count is zero — a failed
// Airtable read must never surface as "0 deals". Build-safe for statically
// prerendered callers: getSocialProofStats catches its own errors → null.
//
// Client pages (deposit checkout) can't render this async component — use
// ProofStripClient there instead.

import { getSocialProofStats } from '@/lib/socialProof';
import ProofStripView from './ProofStripView';

export default async function ProofStrip({
  className = '',
  linkToWins = true,
}: {
  className?: string;
  linkToWins?: boolean;
}) {
  const stats = await getSocialProofStats();
  if (!stats || stats.deals <= 0) return null;
  return (
    <ProofStripView
      data={{
        deals: stats.deals,
        gmvLabel: stats.gmvLabel,
        latestWinLabel: stats.latestWinLabel,
      }}
      className={className}
      linkToWins={linkToWins}
    />
  );
}
