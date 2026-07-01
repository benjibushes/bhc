// Skeleton for the public discover map. Paints the shell instantly (header +
// full-viewport map placeholder) while the server component fetches ranchers
// from Airtable.
export default function MapLoading() {
  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6 md:py-10 animate-pulse">
        {/* Header */}
        <div className="mb-2 h-8 w-2/3 rounded bg-dust/50" />
        <div className="mb-6 h-4 w-1/2 rounded bg-dust/40" />
        {/* Map placeholder */}
        <div className="h-[70vh] w-full rounded-md border border-dust bg-bone-warm/50" />
        {/* Rancher list rows below the map */}
        <div className="mt-6 space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 w-full rounded-md border border-dust bg-bone-warm/50" />
          ))}
        </div>
      </div>
    </main>
  );
}
