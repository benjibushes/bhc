// Route-level skeleton for the product checkout (checkout teardown
// 2026-07-07). The page is force-dynamic (fresh stock truth), so there's a
// real server round-trip before first paint — without this, a buyer who taps
// "buy" stares at the previous page. Mirrors the page's real layout (back
// link → summary card → payment block) so the transition reads as "loading
// your order", not a flash of unrelated chrome.

export default function CheckoutLoading() {
  return (
    <main className="min-h-screen bg-bone text-charcoal pt-7 pb-14 px-4">
      <div className="max-w-[640px] mx-auto animate-pulse">
        <div className="h-3.5 w-16 bg-bone-deep rounded-[3px]" />
        <div className="h-7 w-40 bg-bone-deep rounded-[3px] mt-4 mb-5" />
        <div className="border border-dust bg-bone-warm p-3 flex gap-3.5 items-center mb-4">
          <div className="w-[72px] h-[72px] shrink-0 bg-bone-deep" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-3/4 bg-bone-deep rounded-[3px]" />
            <div className="h-3 w-1/2 bg-bone-deep rounded-[3px]" />
          </div>
          <div className="h-5 w-16 bg-bone-deep rounded-[3px]" />
        </div>
        <div className="bg-white border border-dust p-5">
          <div className="text-saddle text-sm mb-4">securing your checkout&hellip;</div>
          <div className="flex flex-col gap-3">
            {[92, 100, 70, 100, 55].map((w, i) => (
              <div key={i} className="h-3 bg-bone-deep rounded-[3px]" style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
