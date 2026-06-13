// app/rancher/connected/page.tsx
//
// PUBLIC Stripe Connect return page — NO auth, NO data fetch.
//
// Why this exists (fix 2026-06-13): mark-legacy-connect's onboarding link
// used to return cold-link visitors to /rancher/billing?onboarding=done,
// which requires a rancher session. A rancher finishing Stripe Express from
// a texted/emailed link has no session → that page rendered "Error: Not
// authenticated" right after a successful onboarding. This page is a plain,
// session-free confirmation so the return lands clean every time.
//
// NOT gated by proxy.ts — that middleware only protects /admin, /api/admin,
// /api/referrals, /api/inquiries, and /api/affiliate; it does not touch
// /rancher/*, so this page loads without a session.

export const metadata = {
  title: "You're all set — BuyHalfCow",
  robots: { index: false, follow: false },
};

export default function RancherConnectedPage() {
  return (
    <main className="min-h-screen bg-charcoal text-bone flex items-center justify-center px-6 py-16">
      <div className="max-w-md w-full text-center">
        <div className="text-5xl mb-6" aria-hidden="true">
          ✅
        </div>
        <h1 className="font-serif text-3xl md:text-4xl text-bone mb-4">
          You&rsquo;re all set
        </h1>
        <p className="text-lg text-bone/80 leading-relaxed mb-2">
          Your account is connected.
        </p>
        <p className="text-base text-bone/60 leading-relaxed">
          You can close this tab.
        </p>
        <p className="mt-10 text-xs uppercase tracking-widest text-bone/40">
          BuyHalfCow
        </p>
      </div>
    </main>
  );
}
