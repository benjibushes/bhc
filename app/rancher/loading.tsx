// Skeleton for the rancher cockpit. Paints the shell instantly (header + tab
// bar + card list) instead of a blank screen while the dashboard chunk and
// its Airtable-backed data load.
export default function RancherLoading() {
  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-6 md:py-10 animate-pulse">
        {/* Header */}
        <div className="mb-2 h-8 w-1/3 rounded bg-dust/50" />
        <div className="mb-6 h-4 w-1/2 rounded bg-dust/40" />
        {/* Tab bar */}
        <div className="mb-8 flex gap-3 overflow-hidden">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-9 w-24 shrink-0 rounded bg-dust/40" />
          ))}
        </div>
        {/* Card list */}
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 w-full rounded-md border border-dust bg-bone-warm/50" />
          ))}
        </div>
      </div>
    </main>
  );
}
