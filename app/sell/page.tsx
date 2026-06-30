// /sell — rancher-recruitment landing page.
//
// Supply is the constraint: we're recruiting 100 ranchers and there was no
// public landing page or nav link pointing them at the signup. This page is
// the top-of-funnel surface for ranchers — it leads with the FREE-to-start
// model ($0 up front, pay only when you sell on Legacy Connect, or pick a
// plan with commission as low as 0% — tier-based, lib/tiers.ts) and drives to the
// rancher partner application at /apply (rancher-initiated, intent-rich,
// mints a setup-wizard token). Secondary path is /map/add-a-rancher for
// ranchers who'd rather just get on the map first.
//
// Server component (no 'use client') so metadata exports for SEO and the
// page is statically rendered. Full site chrome (Header/Footer) renders
// automatically via app/layout.tsx — /sell is NOT a focused route, so we
// do not duplicate header/footer here.

import type { Metadata } from 'next';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Button from '../components/Button';

export const metadata: Metadata = {
  title: 'Sell your beef on BuyHalfCow — free to join',
  description:
    'Ranchers: sell quarter, half, and whole cows direct to buyers in your state. Free to start, $0 up front — pay only when you sell, or pick a plan with commission as low as 0%. You set your prices, get paid direct.',
  openGraph: {
    title: 'Sell your beef on BuyHalfCow — free to join',
    description:
      'Sell quarter, half, and whole cows direct to buyers in your state. Free to start, $0 up front — pay only when you sell, or pick a plan with commission as low as 0%.',
    type: 'website',
    url: 'https://buyhalfcow.com/sell',
  },
};

// Primary signup entry for ranchers — the partner application that mints a
// setup-wizard token. Found via the /apply page header comment: "Public
// discovery entry point for ranchers" who "want to actively partner with BHC."
const SIGNUP_HREF = '/apply';
// Secondary path — community/self map submission (self path drops straight
// into the setup wizard via /api/prospects/self-submit).
const MAP_HREF = '/map/add-a-rancher';

const STEPS = [
  {
    n: '1',
    t: 'Sign up free',
    d: 'A few fields about your ranch and your state. Takes a couple minutes. No fee to join.',
  },
  {
    n: '2',
    t: 'Set your prices + connect your bank',
    d: 'You name your prices on quarters, halves, and wholes. Link your bank through Stripe for direct deposit.',
  },
  {
    n: '3',
    t: 'We match you with buyers',
    d: 'We send you ready-to-buy families in your state. Pre-screened. You talk to them direct.',
  },
  {
    n: '4',
    t: 'Close the deal, get paid',
    d: 'The buyer brings the deposit. You close it and keep the rest, paid straight to your bank.',
  },
];

const TRUST = [
  {
    t: 'Free to start',
    d: 'No sign-up fee, no catch. On the free plan you only owe us when a deal closes — or pick a monthly plan for a lower commission rate, as low as 0%. Your call.',
  },
  {
    t: 'You set the prices',
    d: 'Your beef, your numbers. We do not set your prices or take your customers. You stay in charge.',
  },
  {
    t: 'Paid direct to your bank',
    d: 'Money goes straight to you through Stripe. No waiting on a payout from us, no held funds.',
  },
  {
    t: 'Leave anytime',
    d: 'Non-exclusive. Pause when your freezer is empty, come back when you have beef to move. No lock-in.',
  },
];

export default function SellPage() {
  return (
    <main className="min-h-screen bg-bone text-charcoal">
      {/* ── HERO ──────────────────────────────────────────────────────── */}
      <section className="py-16 md:py-24">
        <Container>
          <div className="max-w-3xl mx-auto text-center space-y-6">
            <p className="text-xs uppercase tracking-widest text-saddle font-semibold">
              for ranchers
            </p>
            <h1 className="font-serif text-4xl md:text-6xl leading-tight lowercase">
              sell your beef direct.<br />
              keep more of the check.
            </h1>
            <p className="text-xl md:text-2xl max-w-2xl mx-auto leading-relaxed text-saddle">
              BuyHalfCow sends real buyers to your ranch. Quarter, half, or
              whole cow — you set the prices, you talk to the family, you get
              paid direct.
            </p>

            {/* The hook: free to start, stated plain — tier-accurate. */}
            <p className="text-lg md:text-xl max-w-2xl mx-auto leading-relaxed text-charcoal">
              <strong>Free to start. $0 up front.</strong> Pay only when you
              sell — or pick a plan with commission{' '}
              <strong>as low as 0%</strong>. Either way, nothing before you do.
            </p>

            <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
              <Button href={SIGNUP_HREF} variant="primary" size="lg">
                Start selling — it&rsquo;s free
              </Button>
              <Button href={MAP_HREF} variant="secondary" size="lg">
                Just put me on the map
              </Button>
            </div>

            <p className="text-xs text-saddle pt-2">
              No upfront fee · You set your prices · Leave anytime
            </p>
          </div>
        </Container>
      </section>

      <Divider />

      {/* ── HOW IT WORKS ──────────────────────────────────────────────── */}
      <section className="py-20 bg-white">
        <Container>
          <div className="text-center mb-14">
            <h2 className="font-serif text-3xl md:text-5xl mb-4 lowercase">
              how it works
            </h2>
            <p className="text-lg text-saddle max-w-2xl mx-auto">
              Four steps from sign-up to a deposit in your bank. No middleman
              markup, no marketplace listing fees.
            </p>
          </div>

          <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 max-w-5xl mx-auto">
            {STEPS.map((step) => (
              <li
                key={step.n}
                className="border border-dust bg-bone p-6 text-left space-y-3"
              >
                <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl">
                  {step.n}
                </div>
                <p className="font-serif text-xl text-charcoal">{step.t}</p>
                <p className="text-sm text-saddle leading-relaxed">{step.d}</p>
              </li>
            ))}
          </ol>

          <p className="text-center text-sm text-saddle mt-10 max-w-2xl mx-auto">
            The buyer brings the deposit. You keep the rest — paid straight to
            your bank through Stripe.
          </p>
        </Container>
      </section>

      <Divider />

      {/* ── WHY BHC / TRUST ───────────────────────────────────────────── */}
      <section className="py-20">
        <Container>
          <div className="max-w-4xl mx-auto space-y-12">
            <div className="text-center">
              <h2 className="font-serif text-3xl md:text-5xl mb-4 lowercase">
                why ranchers sign on
              </h2>
              <p className="text-lg text-saddle max-w-2xl mx-auto">
                We&rsquo;re not a marketplace and we&rsquo;re not buying your
                beef. We bring you buyers and stay out of the way.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 gap-8 max-w-3xl mx-auto">
              {TRUST.map((item) => (
                <div key={item.t} className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-rust font-serif text-2xl leading-none">✓</span>
                    <p className="font-serif text-xl text-charcoal">{item.t}</p>
                  </div>
                  <p className="text-sm text-saddle leading-relaxed pl-7">
                    {item.d}
                  </p>
                </div>
              ))}
            </div>

            <div className="text-center">
              <p className="text-lg text-saddle">
                Want more leads or a lower rate down the road? We have paid
                tiers for that — but you never have to pay a dime to start.
              </p>
            </div>
          </div>
        </Container>
      </section>

      <Divider />

      {/* ── FINAL CTA ─────────────────────────────────────────────────── */}
      <section className="py-24 bg-saddle text-bone">
        <Container>
          <div className="text-center space-y-8">
            <h2 className="font-serif text-4xl md:text-5xl lowercase">
              ready to move some beef?
            </h2>
            <p className="text-xl max-w-2xl mx-auto">
              Sign up free in a couple minutes. We&rsquo;ll start sending you
              buyers in your state. You only pay when you sell.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center pt-4">
              <a
                href={SIGNUP_HREF}
                className="inline-block px-10 py-5 bg-bone text-charcoal hover:bg-white transition-colors duration-300 font-medium tracking-wider uppercase border-2 border-bone"
              >
                Start selling — it&rsquo;s free
              </a>
              <a
                href={MAP_HREF}
                className="inline-block px-10 py-5 bg-transparent text-bone hover:bg-bone hover:text-charcoal transition-colors duration-300 font-medium tracking-wider uppercase border-2 border-bone"
              >
                Just put me on the map
              </a>
            </div>
            <p className="text-sm pt-4 text-dust">
              Questions?{' '}
              <a href="mailto:contact@buyhalfcow.com" className="underline">
                contact@buyhalfcow.com
              </a>
            </p>
          </div>
        </Container>
      </section>

      <Divider />
    </main>
  );
}
