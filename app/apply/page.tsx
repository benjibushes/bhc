// /apply — pre-wizard fit-check.
//
// Public discovery entry point for ranchers. Unlike /map/add-a-rancher
// (which adds yellow-pin Prospects to the public map for everyone to see),
// /apply is for ranchers who want to actively partner with BHC. The form
// captures qualification context (head/year, channels, constraints) and the
// server ALWAYS auto-approves — every applicant gets the wizard link right
// on the success screen (low-qual just gets flagged for Ben's triage in
// Telegram). Copy fixed 2026-07-08: the old "pre-approval in 24 hours"
// framing was a fake gate that added a day of imagined waiting to an
// instant flow.
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
    'Active ranchers — apply to partner with BuyHalfCow. We send you ready-to-buy families in your state, run the marketing engine, and stay out of your way. Apply in 90 seconds — build your page immediately.',
  openGraph: {
    title: 'Apply to partner · BuyHalfCow',
    description:
      'D2C ranchers — apply to partner. Marketing engine + ready-to-buy families in your state. Apply in 90 seconds — build your page immediately.',
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
            You&apos;re in as soon as you hit submit — the form takes about
            90 seconds, then you build your ranch page right after. If you
            ship D2C beef and want more buyers without running the marketing
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
            Name, ranch, email, state — that&apos;s the whole application.
            A few optional fit-check questions if you have 30 more seconds.
            The link to build your ranch page appears right after you hit
            submit, and we email it too so you can come back later.
          </p>
        </div>

        {/* FORM */}
        <ApplyForm />
      </div>
    </main>
  );
}
