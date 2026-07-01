// Skeleton for the buyer funnel (/access). Shown while the server renders the
// page + resolves config, so the ad front door paints an on-brand frame
// instantly instead of a blank screen (perceived-perf: skeletons feel faster
// than spinners at the same real load).
export default function AccessLoading() {
  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="mx-auto w-full max-w-md px-5 pt-8 sm:max-w-lg animate-pulse">
        <div className="mb-6 flex items-center justify-between">
          <div className="h-4 w-28 rounded bg-dust/50" />
          <div className="h-3 w-24 rounded bg-dust/40" />
        </div>
        <div className="mb-3 h-7 w-3/4 rounded bg-dust/50" />
        <div className="mb-8 h-4 w-2/3 rounded bg-dust/40" />
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-16 w-full rounded-md border border-dust bg-bone-warm/50" />
          ))}
        </div>
        <div className="mt-8 h-12 w-full rounded-md bg-dust/50" />
      </div>
    </main>
  );
}
