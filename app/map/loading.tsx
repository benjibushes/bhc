// Skeleton for the public discover map. Mirrors the immersive hero layout —
// slim title bar over a viewport-filling map block — using the SAME reserved
// heights as DiscoverMapClient's hero, so the skeleton → page swap causes zero
// layout shift while the server component fetches ranchers from Airtable.
export default function MapLoading() {
  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="animate-pulse">
        {/* Map hero placeholder — heights must match DiscoverMapClient. */}
        <div className="relative w-full h-[68dvh] min-h-[460px] md:h-[78dvh] md:min-h-[560px] bg-[#EDE9E2]">
          {/* Slim on-map title bar */}
          <div className="absolute inset-x-0 top-0 flex h-14 items-center gap-3 border-b border-dust/70 bg-bone/90 px-4 md:h-16 md:px-6">
            <div className="h-5 w-56 rounded bg-dust/50" />
            <div className="ml-auto h-7 w-24 rounded-none bg-dust/40" />
          </div>
          {/* Floating filter card */}
          <div className="absolute left-3 top-16 h-10 w-64 border border-dust/60 bg-bone/80 md:top-[4.75rem] md:h-28 md:w-[368px]" />
        </div>
        {/* Below-the-fold copy rows */}
        <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-12 md:px-6">
          <div className="h-7 w-1/3 rounded bg-dust/50" />
          <div className="h-4 w-1/2 rounded bg-dust/40" />
          <div className="h-4 w-2/5 rounded bg-dust/30" />
        </div>
      </div>
    </main>
  );
}
