// /pitch — the full rancher walkthrough. The page Ben texts after a cold
// call ("send me more information"), screen-shares on a live call, and
// links in every follow-up email. /sell stays the short top-of-funnel
// landing; THIS page is the whole story: how the machine works end to
// end, every feature, the money model, the competitive truth, the
// objection answers, and the three doors in.
//
// Content source of truth: docs/RANCHER-PITCH.md (2026-07-08) + the
// LOCKED money model (docs/BUSINESS-MODEL.md ⭐): the rancher keeps 100%
// of their price, BHC's fee is ADDED to the buyer — never "we take a
// cut". Tier numbers from lib/tiers.ts (Free 10% buyer-side · Pasture
// $150/mo 7% · Ranch $350/mo 3% · Operator $500/mo 0%).
//
// Personalization: /pitch?state=TX renders a LIVE waiting-buyer count
// for that state (client fetch, public stats endpoint) — the
// RANCHER-PITCH rule is never quote a stale number on a call.

import type { Metadata } from 'next';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Button from '../components/Button';
import StateCounter from './StateCounter';

export const metadata: Metadata = {
  title: 'How BuyHalfCow works for ranchers — the whole system',
  description:
    'The complete walkthrough: how families find you, how buyers are screened, how deposits land in your own Stripe account, and everything the platform runs for you. You keep 100% of your price.',
  openGraph: {
    title: 'How BuyHalfCow works for ranchers — the whole system',
    description:
      'How families find you, how buyers are screened, how deposits land in your own Stripe account, and everything the platform runs for you.',
    type: 'website',
    url: 'https://www.buyhalfcow.com/pitch',
  },
};

const STEPS = [
  {
    n: '1',
    t: 'Families come to us',
    d: 'They find BuyHalfCow through the discover map, the shop, search, and our content. They are already looking for a ranch — we did not talk them into wanting beef.',
  },
  {
    n: '2',
    t: 'A quiz screens out the unserious',
    d: 'Budget, freezer space, timeline. Nobody reaches you until they have answered all three. Window shoppers never touch your phone.',
  },
  {
    n: '3',
    t: 'Qualified buyers route to YOU',
    d: 'Matched by state first, then real driving distance — local families first. They land on your ranch page: your photos, your story, your prices.',
  },
  {
    n: '4',
    t: 'The deposit lands in YOUR Stripe account',
    d: 'A real deposit, paid on your page, straight into your own Stripe account. Not a lead. A paying customer. Money never sits with us.',
  },
  {
    n: '5',
    t: 'You close it and hand over the beef',
    d: 'You talk to them direct, confirm the cut sheet, arrange pickup or delivery. Your customer, your relationship, your brand on the box.',
  },
  {
    n: '6',
    t: 'The machine keeps working behind you',
    d: 'Stale intros expire and free your slot. Buyers who stall get automatic follow-up. You get leads until your capacity is actually sold out — then it pauses itself.',
  },
];

const FEATURES: { group: string; sub: string; items: string[] }[] = [
  {
    group: 'a storefront, done for you',
    sub: 'Live the day you finish a 5-minute setup.',
    items: [
      'Public ranch page — photos, story, certifications, FAQ, delivery area, pricing',
      'Listed on the discover map + the nationwide shop',
      'Products you add can ship nationwide or sell local-pickup to buyers in your state — your choice per product',
      'You keep 100% of the shipping charge you set',
    ],
  },
  {
    group: 'a sales machine, running for you',
    sub: 'It works nights and weekends so you do not have to.',
    items: [
      'Quiz-qualified buyers only — budget, freezer, and timeline screened before you ever see them',
      'Routed by state and real driving distance — local families first',
      'Deposits collected on-platform into your own Stripe account',
      'Automatic follow-up: stale intros expire, stalled buyers get recovered, nothing falls through a crack',
      'On the Operator plan, Ben personally runs the calls and closes for you',
    ],
  },
  {
    group: 'a back office you do not have to learn',
    sub: 'If you can text, you are overqualified.',
    items: [
      'Phone-first dashboard that installs like an app',
      'Push notification when a buyer lands, a deposit hits, or an order pays',
      'One-input pricing, earnings tab, CSV export for your accountant',
      'Fulfillment tracker, buyer messaging, capacity control ("how many more can I take")',
      'Already selling on Shopify? Connect your store and your products list themselves',
    ],
  },
  {
    group: 'terms that answer every scar the big marketplaces left',
    sub: 'Built to be the opposite of the consignment deal.',
    items: [
      'Your brand and your customer — buyers are routed TO you, never resold',
      'Your Stripe account — money never sits with us',
      'No consignment, no inventory risk, nothing shipped back at your expense',
      'No setup fee, no monthly fee unless you choose one',
      'Non-exclusive. Pause or leave anytime.',
    ],
  },
];

const TIERS = [
  {
    name: 'Free',
    price: '$0/mo',
    fee: 'buyer pays 10% on top',
    note: 'Start here. You never owe us a bill — our fee is added to the buyer at deposit.',
  },
  {
    name: 'Pasture',
    price: '$150/mo',
    fee: 'buyer-side fee drops to 7%',
    note: 'Verified listing + more buyer visibility.',
  },
  {
    name: 'Ranch',
    price: '$350/mo',
    fee: 'buyer-side fee drops to 3%',
    note: 'Buyers see you first in your state.',
  },
  {
    name: 'Operator',
    price: '$500/mo',
    fee: '0% — no fee at all',
    note: 'We close, you ship. Ben runs the sales calls, the follow-up, the deposit chase. You get texts that beef is sold.',
  },
];

const COMPETITORS = [
  {
    who: 'Barn2Door',
    cost: '$99–299/mo + $399–599 setup',
    truth:
      'Their own FAQ says they "teach farmers how to fish" — finding customers is your problem, and marketing help costs extra.',
  },
  {
    who: 'GrazeCart',
    cost: '~$89–199/mo + 2.9%',
    truth: 'A nice cash register. It does not put a single person in line at it.',
  },
  {
    who: 'Local Line',
    cost: '$99–399/mo',
    truth: 'A wholesale directory for restaurants. No answer to "where does my next half-beef buyer come from."',
  },
  {
    who: 'Crowd Cow',
    cost: '22% + you eat processing and freight',
    truth:
      'Consignment. They own the customer, and unsold product ships back after 90 days at your expense.',
  },
  {
    who: 'Doing it yourself',
    cost: '"free"',
    truth:
      'DMs, no-shows, chasing checks — four buyers per animal found, qualified, and scheduled by hand. You pay in weekends.',
  },
];

const OBJECTIONS = [
  {
    q: '"Marketplaces steal your customers."',
    a: 'The buyer pays into YOUR Stripe account and lands on YOUR page. We physically cannot own your customer — it is not how this is built.',
  },
  {
    q: '"I have paid for leads that never closed."',
    a: 'You do not pay for leads. On the free plan, our fee comes from a deposit that already happened — and the buyer paid it, not you. No deposit, no cost, ever.',
  },
  {
    q: '"I do not do tech."',
    a: 'If you can text, you are overqualified. Five-minute setup, and the Operator plan means we even do the selling.',
  },
  {
    q: '"What is the catch on free?"',
    a: 'The catch is we only make money when you do. That is the whole design.',
  },
  {
    q: '"How do I know the buyers are real?"',
    a: 'Every one passed a quiz — budget, freezer, timeline — and put real money down before you spend a minute on them.',
  },
];

export default async function PitchPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const params = await searchParams;
  const state = (params.state || '').trim().toUpperCase().slice(0, 2);

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      {/* ── HERO ──────────────────────────────────────────────────────── */}
      <section className="pt-8 pb-12 md:py-20">
        <Container>
          <div className="max-w-3xl mx-auto text-center space-y-6">
            <p className="text-xs uppercase tracking-widest text-saddle font-semibold">
              for ranchers · the whole system
            </p>
            <h1 className="font-serif text-4xl md:text-6xl leading-tight lowercase">
              this is exactly how it works.
            </h1>
            <p className="text-lg md:text-xl max-w-2xl mx-auto leading-relaxed text-saddle">
              Every beef tool out there sells ranchers software and leaves them
              to find their own buyers. We built the opposite — a demand
              engine. Families come to us looking for a ranch, we qualify
              them, take their deposit, and route them to you until your
              capacity is sold out. You raise the beef and hand it over.
            </p>
            <p className="font-serif text-xl md:text-2xl text-charcoal">
              They sell you a cash register.
              <br />
              We show up with the line of customers.
            </p>
            {state ? (
              <div className="pt-2">
                <StateCounter state={state} />
              </div>
            ) : null}
          </div>
        </Container>
      </section>

      <Divider />

      {/* ── HOW IT WORKS, END TO END ──────────────────────────────────── */}
      <section className="py-16 md:py-20 bg-white">
        <Container>
          <div className="text-center mb-12">
            <h2 className="font-serif text-3xl md:text-5xl mb-4 lowercase">
              from a family&rsquo;s first click to money in your bank
            </h2>
            <p className="text-lg text-saddle max-w-2xl mx-auto">
              Six steps. You are only needed for one of them — the part where
              you are the rancher.
            </p>
          </div>
          <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 max-w-5xl mx-auto">
            {STEPS.map((step) => (
              <li key={step.n} className="border border-dust bg-bone p-6 text-left space-y-3">
                <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl">
                  {step.n}
                </div>
                <p className="font-serif text-xl text-charcoal">{step.t}</p>
                <p className="text-sm text-saddle leading-relaxed">{step.d}</p>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      <Divider />

      {/* ── THE MONEY ─────────────────────────────────────────────────── */}
      <section className="py-16 md:py-20">
        <Container>
          <div className="max-w-4xl mx-auto space-y-10">
            <div className="text-center space-y-4">
              <h2 className="font-serif text-3xl md:text-5xl lowercase">the money, plainly</h2>
              <p className="text-lg text-saddle max-w-2xl mx-auto">
                You keep <strong className="text-charcoal">100% of the price you set</strong>.
                Our fee is added on top and paid by the buyer at deposit —
                you never owe us a bill. And on our checkout, card processing
                is on us: <strong className="text-charcoal">the number you set is the number you
                get</strong>.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full max-w-3xl mx-auto text-left border-collapse">
                <thead>
                  <tr className="border-b-2 border-charcoal">
                    <th className="py-3 pr-4 font-serif text-lg">plan</th>
                    <th className="py-3 pr-4 font-serif text-lg">you pay</th>
                    <th className="py-3 font-serif text-lg">the fee</th>
                  </tr>
                </thead>
                <tbody>
                  {TIERS.map((t) => (
                    <tr key={t.name} className="border-b border-dust align-top">
                      <td className="py-4 pr-4 font-semibold whitespace-nowrap">{t.name}</td>
                      <td className="py-4 pr-4 whitespace-nowrap">{t.price}</td>
                      <td className="py-4">
                        <span className="font-medium">{t.fee}</span>
                        <span className="block text-sm text-saddle mt-1">{t.note}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Container>
      </section>

      <Divider />

      {/* ── EVERYTHING YOU GET ────────────────────────────────────────── */}
      <section className="py-16 md:py-20 bg-white">
        <Container>
          <div className="text-center mb-12">
            <h2 className="font-serif text-3xl md:text-5xl mb-4 lowercase">
              everything the platform runs for you
            </h2>
            <p className="text-lg text-saddle max-w-2xl mx-auto">
              Four systems, one login. All of it included from day one.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-8 max-w-5xl mx-auto">
            {FEATURES.map((f) => (
              <div key={f.group} className="border border-dust bg-bone p-6 space-y-3">
                <p className="font-serif text-2xl text-charcoal lowercase">{f.group}</p>
                <p className="text-sm text-saddle italic">{f.sub}</p>
                <ul className="space-y-2">
                  {f.items.map((item) => (
                    <li key={item} className="flex items-start gap-2 text-sm leading-relaxed">
                      <span className="text-rust font-serif leading-none mt-0.5">✓</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <Divider />

      {/* ── THE HONEST COMPARISON ─────────────────────────────────────── */}
      <section className="py-16 md:py-20">
        <Container>
          <div className="max-w-4xl mx-auto space-y-8">
            <div className="text-center space-y-4">
              <h2 className="font-serif text-3xl md:text-5xl lowercase">
                the honest comparison
              </h2>
              <p className="text-lg text-saddle max-w-2xl mx-auto">
                Nobody else in this market sells demand. Here is what the
                other tools actually charge, and what they actually do.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[560px]">
                <thead>
                  <tr className="border-b-2 border-charcoal">
                    <th className="py-3 pr-4 font-serif text-lg">the tool</th>
                    <th className="py-3 pr-4 font-serif text-lg">what it costs</th>
                    <th className="py-3 font-serif text-lg">the truth</th>
                  </tr>
                </thead>
                <tbody>
                  {COMPETITORS.map((c) => (
                    <tr key={c.who} className="border-b border-dust align-top">
                      <td className="py-4 pr-4 font-semibold whitespace-nowrap">{c.who}</td>
                      <td className="py-4 pr-4 text-sm">{c.cost}</td>
                      <td className="py-4 text-sm text-saddle leading-relaxed">{c.truth}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-center text-saddle text-sm max-w-2xl mx-auto">
              &ldquo;Qualified local buyer, deposit down, routed into your own
              Stripe account&rdquo; — no one else offers it. That is the whole
              reason this exists.
            </p>
          </div>
        </Container>
      </section>

      <Divider />

      {/* ── STRAIGHT ANSWERS ──────────────────────────────────────────── */}
      <section className="py-16 md:py-20 bg-white">
        <Container>
          <div className="max-w-3xl mx-auto space-y-8">
            <h2 className="font-serif text-3xl md:text-5xl lowercase text-center">
              straight answers to fair questions
            </h2>
            <div className="space-y-6">
              {OBJECTIONS.map((o) => (
                <div key={o.q} className="border-l-4 border-rust pl-5 space-y-1">
                  <p className="font-serif text-lg text-charcoal">{o.q}</p>
                  <p className="text-saddle leading-relaxed">{o.a}</p>
                </div>
              ))}
            </div>
          </div>
        </Container>
      </section>

      <Divider />

      {/* ── THE THREE DOORS ───────────────────────────────────────────── */}
      <section className="py-20 bg-saddle text-bone">
        <Container>
          <div className="text-center space-y-10 max-w-4xl mx-auto">
            <h2 className="font-serif text-4xl md:text-5xl lowercase">your three ways in</h2>
            <div className="grid md:grid-cols-3 gap-6 text-left">
              <div className="border-2 border-bone p-6 space-y-3 rounded-sm">
                <p className="font-serif text-2xl">1 · start free</p>
                <p className="text-sm leading-relaxed text-dust">
                  90-second application. Your page is live the same day, buyers
                  in your state start routing to you, and you owe nothing —
                  ever. The buyer pays our fee on top.
                </p>
                <Button href="/apply" variant="accent" size="md">
                  Start the application
                </Button>
              </div>
              <div className="border-2 border-bone p-6 space-y-3 rounded-sm">
                <p className="font-serif text-2xl">2 · operator</p>
                <p className="text-sm leading-relaxed text-dust">
                  $500/mo, zero fees. We run the sales calls, the follow-up,
                  and the deposit chase. You confirm prices and hand over
                  beef. Best if your freezer is full and your weekends are not.
                </p>
                <Button href="/book?purpose=rancher" variant="secondary" size="md">
                  Book the call
                </Button>
              </div>
              <div className="border-2 border-bone p-6 space-y-3 rounded-sm">
                <p className="font-serif text-2xl">3 · bring your store</p>
                <p className="text-sm leading-relaxed text-dust">
                  Already selling on Shopify or your own site? Connect it and
                  keep your whole stack — we route our buyers to your
                  existing checkout and products.
                </p>
                <Button href="/book?purpose=rancher" variant="secondary" size="md">
                  Talk it through
                </Button>
              </div>
            </div>
            <p className="text-sm text-dust">
              Not sure which? Reply to the email that brought you here, or
              write{' '}
              <a href="mailto:contact@buyhalfcow.com" className="underline">
                contact@buyhalfcow.com
              </a>
              . Real person, usually same day.
            </p>
          </div>
        </Container>
      </section>

      <Divider />
    </main>
  );
}
