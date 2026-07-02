// Map legend, two renders sharing one source of truth for the swatches:
//
//   compact  — the always-visible on-map card (bottom-left of the hero).
//              Buyer language, four words per row, glanceable.
//   detailed — the below-the-fold explainer on /map. Full sentences, SSR'd,
//              doubles as indexable "how the map works" copy.
//
// Swatch shapes mirror the live pins exactly: teardrops for verified /
// onboarding / self-submitted, a muted DOT for prospects (prospects render as
// dots on the map, not teardrops — de-emphasized on purpose).

function PinSwatch({ fill, stroke }: { fill: string; stroke: string }) {
  return (
    <span
      aria-hidden
      className="mt-0.5 inline-block h-3.5 w-2.5 shrink-0"
      style={{
        backgroundColor: fill,
        border: `1.5px solid ${stroke}`,
        borderRadius: '6px 6px 0 50%',
      }}
    />
  );
}

function DotSwatch() {
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: '#A7A29A', border: '1.5px solid #6B4F3F' }}
    />
  );
}

const ROWS = [
  {
    swatch: <PinSwatch fill="#4F7A3F" stroke="#2A4A20" />,
    short: 'Taking reservations',
    long: (
      <>
        <strong>Taking reservations</strong> — verified partner shipping via
        BuyHalfCow today
      </>
    ),
  },
  {
    swatch: <PinSwatch fill="#D97757" stroke="#8C3D1F" />,
    short: 'Onboarding now',
    long: (
      <>
        <strong>Onboarding</strong> — actively being verified · call · docs ·
        agreement · final review
      </>
    ),
  },
  {
    swatch: <PinSwatch fill="#E8C547" stroke="#8A6F1A" />,
    short: 'Raised a hand',
    long: (
      <>
        <strong>Raised a hand</strong> — rancher self-submitted or was flagged by
        a fan. Onboarding pending.
      </>
    ),
  },
  {
    swatch: <DotSwatch />,
    short: 'On our radar',
    long: (
      <>
        <strong>On our radar</strong> — direct-to-consumer rancher we&rsquo;re
        working to bring in. Unclaimed.
      </>
    ),
  },
];

export default function MapLegend({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="space-y-1.5 border border-dust bg-bone/90 px-3 py-2 shadow-sm backdrop-blur-sm">
        {ROWS.map((r) => (
          <p key={r.short} className="flex items-center gap-2 text-[11px] leading-none text-charcoal/85">
            {r.swatch}
            {r.short}
          </p>
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-4 text-sm text-charcoal/80">
      {ROWS.map((r) => (
        <div key={r.short} className="flex items-start gap-2.5">
          {r.swatch}
          <span>{r.long}</span>
        </div>
      ))}
    </div>
  );
}
