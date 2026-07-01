// Skeleton for the member dashboard. Paints the shell instantly instead of the
// full-screen auth spinner → dashboard waterfall.
export default function MemberLoading() {
  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6 md:py-10 animate-pulse">
        <div className="mb-2 h-8 w-1/2 rounded bg-dust/50" />
        <div className="mb-8 h-4 w-2/3 rounded bg-dust/40" />
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 w-full rounded-md border border-dust bg-bone-warm/50" />
          ))}
        </div>
      </div>
    </main>
  );
}
