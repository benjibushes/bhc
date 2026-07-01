// Skeleton for the checkout/deposit flow. Mirrors the deposit layout (rancher
// card → cut options → cost box → CTA) so the highest-intent page paints a
// frame instantly instead of the old bare "Loading…".
export default function CheckoutLoading() {
  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="mx-auto w-full max-w-2xl px-4 py-8 md:px-6 md:py-12 animate-pulse">
        <div className="mb-6 h-8 w-2/3 rounded bg-dust/50" />
        <div className="mb-6 h-20 w-full rounded-md border border-dust bg-bone-warm/50" />
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-16 w-full rounded-md border border-dust bg-bone-warm/50" />
          ))}
        </div>
        <div className="mt-6 h-24 w-full rounded-md bg-dust/30" />
        <div className="mt-6 h-12 w-full rounded-md bg-dust/50" />
      </div>
    </main>
  );
}
