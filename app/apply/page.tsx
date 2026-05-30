// /apply — pre-wizard fit-check.
//
// Public discovery entry point for ranchers. Unlike /map/add-a-rancher
// (which adds yellow-pin Prospects to the public map for everyone to see),
// /apply is for ranchers who want to actively partner with BHC. The form
// captures qualification context (head/year, channels, constraints) then
// either mints a wizard token + redirects them straight in (high-qual)
// or queues for manual review (low-qual).
//
// Why separate from /map/add-a-rancher: the map form is "every D2C rancher
// in America" — submission is community-driven, sometimes a third-party
// is flagging the rancher. The apply form is rancher-initiated, intent-rich,
// pre-qualified for active partnership.

import type { Metadata } from 'next';
import ApplyForm from './ApplyForm';

export const metadata: Metadata = {
  title: 'Apply to partner · BuyHalfCow',
  description:
    'Active ranchers — apply to partner with BuyHalfCow. We send you ready-to-buy families in your state, run the marketing engine, and stay out of your way. Pre-approval in 24 hours.',
  openGraph: {
    title: 'Apply to partner · BuyHalfCow',
    description:
      'D2C ranchers — apply to partner. Marketing engine + ready-to-buy families in your state. Pre-approval in 24h.',
    type: 'website',
    url: 'https://www.buyhalfcow.com/apply',
  },
};

export const dynamic = 'force-dynamic';

export default function ApplyPage() {
  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="mx-auto max-w-3xl px-5 sm:px-6 py-10 sm:py-16">
        {/* HERO */}
        <div className="max-w-2xl mb-10">
          <p className="text-xs uppercase tracking-wider text-saddle font-semibold mb-3">
            apply to partner
          </p>
          <h1 className="font-serif text-3xl sm:text-5xl text-charcoal lowercase leading-[1.05] mb-4">
            tell us about your ranch.
          </h1>
          <p className="text-saddle text-base sm:text-lg leading-relaxed">
            We pre-approve serious ranchers in 24 hours. If you ship D2C
            beef and want more buyers without running the marketing
            yourself — this is for you.
          </p>
        </div>

        {/* TRUST STRIP */}
        <div className="mb-8 flex flex-wrap gap-x-6 gap-y-2 text-xs text-saddle">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-charcoal font-semibold">✓</span>
            no upfront fee
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-charcoal font-semibold">✓</span>
            pause or leave anytime
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-charcoal font-semibold">✓</span>
            you set prices, capacity, pace
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-charcoal font-semibold">✓</span>
            non-exclusive
          </span>
        </div>

        {/* WHAT WE'LL ASK */}
        <div className="mb-10 border border-dust bg-bone-warm/40 p-5 sm:p-6 max-w-2xl">
          <p className="text-xs uppercase tracking-wider text-saddle font-semibold mb-3">
            what we'll ask
          </p>
          <p className="text-sm sm:text-base text-charcoal leading-relaxed">
            Basic contact + state, then 4 fit-check questions about your
            volume, current channels, and biggest constraint. Takes about
            2 minutes. Approved applicants get a wizard link emailed
            within 24 hours — most get same-day.
          </p>
        </div>

        {/* FORM */}
        <ApplyForm />
      </div>
    </main>
  );
}
