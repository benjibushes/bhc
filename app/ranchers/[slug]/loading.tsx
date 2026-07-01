// Skeleton for the rancher storefront (/ranchers/[slug]). Shown during the
// ISR/data fetch so a cold regen paints a hero + card frame instead of blank,
// esp. on mobile ad traffic.
export default function RancherStorefrontLoading() {
  return (
    <main className="min-h-screen bg-bone text-charcoal animate-pulse">
      <div className="h-56 w-full bg-dust/40 md:h-72" />
      <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6">
        <div className="mb-3 h-8 w-1/2 rounded bg-dust/50" />
        <div className="mb-8 h-4 w-2/3 rounded bg-dust/40" />
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 rounded-md border border-dust bg-bone-warm/50" />
          ))}
        </div>
        <div className="mt-8 h-12 w-full rounded-md bg-dust/50" />
      </div>
    </main>
  );
}
