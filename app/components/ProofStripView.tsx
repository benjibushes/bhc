// ProofStripView — the shared presentational markup for the social-proof
// strip. Pure props-in/markup-out so BOTH trees can render it:
//   • server: app/components/ProofStrip.tsx (async, reads lib/socialProof)
//   • client: app/components/ProofStripClient.tsx (fetches /api/social-proof
//     for 'use client' pages like the deposit checkout)
//
// Copy rules (docs/BHC.md): lowercase, honest, aggregates only — never a
// buyer name. "real deals closed" deliberately matches /wins language and
// deliberately does NOT reuse the funnel header's "families matched" phrase
// (that metric is a different, floored count from /api/funnel/stats — two
// surfaces saying "N families matched" with different Ns would read as a lie).
//
// Renders NOTHING when deals <= 0 — no zeroes, no placeholders.

export interface ProofStripData {
  deals: number;
  gmvLabel: string;
  latestWinLabel: string | null;
}

export default function ProofStripView({
  data,
  className = '',
  linkToWins = true,
}: {
  data: ProofStripData;
  className?: string;
  /** false on checkout — never hand a paying buyer an exit link. */
  linkToWins?: boolean;
}) {
  const { deals, gmvLabel, latestWinLabel } = data;
  if (!Number.isFinite(deals) || deals <= 0) return null;
  return (
    <p className={`text-[12.5px] leading-relaxed text-saddle ${className}`}>
      <strong className="font-semibold text-charcoal">
        {deals} real {deals === 1 ? 'deal' : 'deals'} closed
      </strong>
      {gmvLabel && (
        <>
          {' '}&middot;{' '}
          <strong className="font-semibold text-charcoal">{gmvLabel}</strong> in beef
          reserved through BHC
        </>
      )}
      {latestWinLabel && <> &middot; latest: {latestWinLabel}</>}
      {linkToWins && (
        <>
          {' '}&middot;{' '}
          <a
            href="/wins"
            className="underline underline-offset-2 hover:text-charcoal transition-colors"
          >
            see every win &rarr;
          </a>
        </>
      )}
    </p>
  );
}
