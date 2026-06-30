'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Container from './Container';
import Divider from './Divider';
import Button from './Button';
import LiveCounter from './LiveCounter';

// CampaignTracker moved to app/components/UtmCapture.tsx + mounted in
// app/layout.tsx so UTM/fbclid/gclid land on EVERY entry page, not just /.
// See: 2026-05-27 P0 marketing fix I-2.

function useLiveStats() {
  const [stats, setStats] = useState<{ rancherCount: number; buyerCount: number; stateCount: number } | null>(null);

  useEffect(() => {
    fetch('/api/stats/public')
      .then(r => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  return stats;
}

export default function FullHomepage() {
  const stats = useLiveStats();
  const totalMembers = stats ? stats.rancherCount + stats.buyerCount : null;

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      {/* Logo + Hero */}
      <section className="py-12 md:py-20">
        <Container>
          <div className="text-center space-y-8">
            <div className="flex justify-center mb-8">
              <div className="w-32 h-32 md:w-40 md:h-40 relative flex items-center justify-center">
                <Image
                  src="/bhc-logo.png"
                  alt="BuyHalfCow"
                  width={160}
                  height={160}
                  className="object-contain"
                  priority
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden'); }}
                />
                <span className="font-serif text-6xl md:text-7xl hidden">BHC</span>
              </div>
            </div>

            <h1 className="font-serif text-4xl md:text-6xl lg:text-7xl leading-tight lowercase">
              {totalMembers
                ? <>{totalMembers.toLocaleString()}+ members<br />rebuilding real food</>
                : <>a private network<br />rebuilding real food</>}
            </h1>

            <p className="text-xl md:text-2xl max-w-2xl mx-auto leading-relaxed text-saddle">
              Connecting every household to a ranch they trust. Direct from
              verified American ranchers. Quarter, half, or whole cow — the
              way local families have been doing it for generations. No
              marketplace markup. No algorithms.
            </p>

            <LiveCounter />


            <p className="text-sm text-saddle pt-2">
              Follow the movement:{' '}
              <a href="https://instagram.com/buyhalfcow" target="_blank" rel="noopener noreferrer" className="underline hover:text-charcoal transition-colors">@buyhalfcow</a>
            </p>
          </div>
        </Container>
      </section>

      <Divider />

      {/* BUYER-PRIMARY CTA — pre-rebuild this was a 4-card "pick your path" grid
          (buyer + rancher + land + brand) which forced visitors to self-segment
          before doing anything. The buyer card was 1 of 4 equal-size, which made
          our highest-volume audience indistinguishable from non-buyer audiences
          on the homepage. Demoted rancher / land / brand to a single discreet
          partner link below — they still have flows at /partner, just not on
          the buyer's primary surface. */}
      <section className="py-20">
        <Container>
          <div className="max-w-3xl mx-auto text-center">
            <h2 className="font-serif text-3xl md:text-4xl mb-4 lowercase">
              source beef directly from a real ranch
            </h2>
            <p className="text-lg text-saddle mb-10">
              Answer a few questions and we match you with a verified rancher serving your area — or put you first in line as we bring one to your state. You talk to them direct, set your cuts, pick your processing date. You pay the rancher, not a marketplace.
              {totalMembers ? ` Join ${totalMembers.toLocaleString()}+ members already sourcing direct.` : ''}
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Button href="/access" size="lg">
                Get matched in 90 seconds
              </Button>
              <Button href="/start" variant="secondary" size="lg">
                Not sure? Start here
              </Button>
            </div>
            <p className="text-xs text-saddle mt-8">
              Raise cattle?{' '}
              <a href="/sell" className="underline hover:text-charcoal transition-colors">
                Sell direct — free to join
              </a>
              {' · '}Brand or land to list?{' '}
              <a href="/partner" className="underline hover:text-charcoal transition-colors">
                Partner with us
              </a>
            </p>
          </div>

          {/* ── BUYER FUNNEL PREVIEW ───────────────────────────────────────
              Sets expectations BEFORE the buyer hits /access. Uses the ONE
              canonical 4-step buyer model (Apply → Get routed → Talk direct →
              Beef in your freezer) — identical labels to the "for buyers"
              track in the "how it works" section below, so the buyer sees the
              same path twice, not two conflicting maps.
             ───────────────────────────────────────────────────────────────── */}
          <div className="mt-20 max-w-5xl mx-auto">
            <p className="text-xs uppercase tracking-widest text-saddle text-center mb-6">How it works · 4 steps to stocked</p>
            <ol className="grid grid-cols-1 sm:grid-cols-4 gap-4 md:gap-3">
              {[
                { n: '1', t: 'Apply', d: '90-second quiz. We capture your state, household size, timing.' },
                { n: '2', t: 'Get routed', d: 'We match you with a verified rancher serving your area within hours.' },
                { n: '3', t: 'Talk direct', d: 'Rancher emails you direct with pricing, cuts, processing date.' },
                { n: '4', t: 'Beef in your freezer', d: '2–4 weeks. No marketplace markup. BHC Promise on every match.' },
              ].map((step) => (
                <li
                  key={step.n}
                  className="border border-dust bg-white p-4 md:p-5 text-left space-y-2"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-serif text-2xl md:text-3xl text-charcoal">{step.n}</span>
                    <span className="text-xs uppercase tracking-widest text-saddle">Step</span>
                  </div>
                  <p className="font-serif text-lg text-charcoal">{step.t}</p>
                  <p className="text-xs text-saddle leading-relaxed">{step.d}</p>
                </li>
              ))}
            </ol>
            <p className="text-center text-xs text-saddle mt-6">
              No marketplace. No middleman markup. Direct relationship with the rancher who raised your beef.
            </p>
          </div>
        </Container>
      </section>

      {/* Landscape image strip — break up the text wall + signal authenticity.
          Plain <img> instead of next/image because the source is the Shopify
          CDN and we haven't allowlisted it in next.config. eager-load above
          the fold; lazy below. */}
      <section className="relative w-full overflow-hidden">
        <img
          src="https://cdn.shopify.com/s/files/1/0720/5348/9896/files/MAKE_AMERICA_GRASS_FED_-_LOS_RIOS_FARM-259.jpg?v=1739935780"
          alt="A rancher wearing the BuyHalfCow trucker hat in a grass-fed field"
          className="w-full h-[260px] md:h-[420px] object-cover"
          loading="eager"
          fetchPriority="high"
        />
      </section>

      <Divider />

      {/* MOVEMENT + FOUNDERS CTA — drive campaign traffic into the two new
          surfaces: the public discover map (every D2C rancher in America)
          and the Founding Herd subscription tiers. Both are essential to
          the marketing campaign and were previously orphaned pages. */}
      <section className="py-16">
        <Container>
          <div className="grid md:grid-cols-2 gap-6 max-w-4xl mx-auto">
            <a
              href="/map"
              className="block p-8 border-2 border-charcoal hover:bg-charcoal hover:text-bone transition-colors group"
            >
              <p className="text-xs uppercase tracking-widest text-saddle group-hover:text-dust mb-3">
                The Discover Map
              </p>
              <h3 className="font-serif text-2xl md:text-3xl mb-3">
                Every D2C rancher in America
              </h3>
              <p className="text-sm text-saddle group-hover:text-dust leading-relaxed mb-4">
                A map of every D2C rancher shipping direct to families. Find one near you, or
                add a rancher you know to the map.
              </p>
              <span className="text-sm font-bold uppercase tracking-widest">
                View the map &rarr;
              </span>
            </a>
            <a
              href="/founders"
              className="block p-8 border-2 border-charcoal bg-charcoal text-bone hover:bg-bone hover:text-charcoal transition-colors group"
            >
              <p className="text-xs uppercase tracking-widest text-dust group-hover:text-saddle mb-3">
                The Founding Herd
              </p>
              <h3 className="font-serif text-2xl md:text-3xl mb-3">
                Back the food revolution
              </h3>
              <p className="text-sm text-dust group-hover:text-saddle leading-relaxed mb-4">
                Founder tiers from $9/mo to $15k lifetime. Limited Founding 100 seats. Help
                fund the platform that takes families off mystery grocery beef.
              </p>
              <span className="text-sm font-bold uppercase tracking-widest">
                See the tiers &rarr;
              </span>
            </a>
          </div>
        </Container>
      </section>

      <Divider />

      {/* MERCH / HATS SECTION — drives traffic to merch.buyhalfcow.com.
          New hat drop replaces the legacy Sackett collab CTA. Free
          shipping over $35 mirrors Shopify shipping rule. Product
          images sourced from the Shopify CDN (BHC + Vuck Fegans hats). */}
      <section className="py-20 bg-charcoal text-bone">
        <Container>
          <div className="grid md:grid-cols-2 gap-10 items-center max-w-5xl mx-auto">
            {/* Product image collage */}
            <div className="grid grid-cols-2 gap-3">
              <a
                href="https://merch.buyhalfcow.com/products/buy-half-cow-trucker?utm_source=buyhalfcow&utm_medium=hero-image&utm_campaign=hat-launch"
                target="_blank"
                rel="noopener noreferrer"
                className="block aspect-square overflow-hidden bg-bone/5 border border-bone/10 hover:border-bone transition-colors"
              >
                <img
                  src="https://cdn.shopify.com/s/files/1/0720/5348/9896/files/MAKE_AMERICA_GRASS_FED_-_LOS_RIOS_FARM-259.jpg?v=1739935780"
                  alt="BUY HALF COW Trucker hat"
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              </a>
              <a
                href="https://merch.buyhalfcow.com/products/vuck-fegans-trucker?utm_source=buyhalfcow&utm_medium=hero-image&utm_campaign=hat-launch"
                target="_blank"
                rel="noopener noreferrer"
                className="block aspect-square overflow-hidden bg-bone/5 border border-bone/10 hover:border-bone transition-colors"
              >
                <img
                  src="https://cdn.shopify.com/s/files/1/0720/5348/9896/files/retro-trucker-hat-white-front-67b54f8b08425.jpg?v=1739935633"
                  alt="Vuck Fegans Trucker hat"
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              </a>
            </div>

            {/* Copy + CTA */}
            <div className="text-center md:text-left space-y-6">
              <p className="text-xs uppercase tracking-[0.3em] text-dust">New drop</p>
              <h2 className="font-serif text-4xl md:text-5xl lowercase">
                rep the herd
              </h2>
              <p className="text-lg text-dust leading-relaxed">
                Trucker hats made for ranchers, beef lovers, and anyone who knows
                where their food comes from.
                <br />
                <strong className="text-bone">Free shipping over $35. Ships in 5–7 days.</strong>
              </p>

              <div className="pt-2">
                <Button
                  href="https://merch.buyhalfcow.com/collections/hats?utm_source=buyhalfcow&utm_medium=homepage-hero&utm_campaign=hat-launch"
                  external
                  size="lg"
                  className="bg-bone text-charcoal border-bone hover:bg-dust hover:border-dust hover:text-bone"
                >
                  shop hats →
                </Button>
              </div>
              <p className="text-sm text-dust">
                HERD members only. Limited runs.
              </p>
            </div>
          </div>
        </Container>
      </section>

      <Divider />

      {/* HOW WE'RE DIFFERENT */}
      <section className="py-20">
        <Container>
          <div className="max-w-4xl mx-auto space-y-12">
            <div className="text-center">
              <h2 className="font-serif text-4xl md:text-5xl mb-6 lowercase">
                how we're different
              </h2>
              <p className="text-xl leading-relaxed text-saddle">
                BuyHalfCow is the only <strong className="text-charcoal">private, approval-only</strong> network for sourcing ranch beef direct. Every rancher is verified. Every buyer is vetted. Every connection is logged.
              </p>
            </div>

            <Divider />

            <div className="grid md:grid-cols-3 gap-8">
              <div className="text-center space-y-4">
                <div className="text-4xl">01</div>
                <h3 className="font-serif text-xl">Approval-only access</h3>
                <p className="text-sm text-saddle leading-relaxed">
                  Every buyer passes a short qualification quiz before any introduction. No bots, no spam, no tire-kickers.
                </p>
              </div>
              <div className="text-center space-y-4">
                <div className="text-4xl">02</div>
                <h3 className="font-serif text-xl">Verified ranchers</h3>
                <p className="text-sm text-saddle leading-relaxed">
                  We verify ranchers through direct outreach + signed partnership agreements. Only real operations make the network.
                </p>
              </div>
              <div className="text-center space-y-4">
                <div className="text-4xl">03</div>
                <h3 className="font-serif text-xl">Direct relationships</h3>
                <p className="text-sm text-saddle leading-relaxed">
                  We make the introduction, then get out of the way. You deal directly with your rancher.
                </p>
              </div>
            </div>

            <Divider />

            <div className="text-center">
              <p className="text-lg text-saddle">
                No e-commerce checkout. No public marketplace. No algorithms.<br />
                <strong className="text-charcoal">Just real people, real beef, real trust.</strong>
              </p>
            </div>
          </div>
        </Container>
      </section>

      <Divider />

      {/* HOW IT WORKS - By User Type */}
      <section className="py-20 bg-white">
        <Container>
          <div className="text-center mb-16">
            <h2 className="font-serif text-4xl md:text-5xl mb-4 lowercase">
              how it works
            </h2>
          </div>

          <div className="max-w-5xl mx-auto space-y-16">
            {/* For Buyers */}
            <div className="space-y-6">
              <h3 className="font-serif text-3xl text-center mb-8 lowercase">for buyers</h3>
              <div className="grid md:grid-cols-4 gap-6">
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">1</div>
                  <p className="font-medium">Apply</p>
                  <p className="text-sm text-saddle">90-second quiz. We capture your state, household size, timing.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">2</div>
                  <p className="font-medium">Get routed</p>
                  <p className="text-sm text-saddle">We match you with a verified rancher serving your area within hours.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">3</div>
                  <p className="font-medium">Talk direct</p>
                  <p className="text-sm text-saddle">Rancher emails you direct with pricing, cuts, processing date.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">4</div>
                  <p className="font-medium">Beef in your freezer</p>
                  <p className="text-sm text-saddle">2–4 weeks. No marketplace markup. BHC Promise on every match.</p>
                </div>
              </div>
            </div>

            <Divider />

            {/* For Ranchers */}
            <div className="space-y-6">
              <h3 className="font-serif text-3xl text-center mb-8 lowercase">for ranchers</h3>
              <div className="grid md:grid-cols-4 gap-6">
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">1</div>
                  <p className="font-medium">Join free</p>
                  <p className="text-sm text-saddle">$0 to start. A few fields, then a guided setup wizard.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">2</div>
                  <p className="font-medium">Set up</p>
                  <p className="text-sm text-saddle">Set your prices, connect your bank for direct payouts, go live.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">3</div>
                  <p className="font-medium">Get matched buyers</p>
                  <p className="text-sm text-saddle">Pre-qualified buyers in your area come to you. You close it direct.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">4</div>
                  <p className="font-medium">Pick your plan</p>
                  <p className="text-sm text-saddle">Start free and pay only when you sell, or pick a plan with commission as low as 0%. Nothing up front, pause or leave anytime.</p>
                </div>
              </div>
            </div>
          </div>
        </Container>
      </section>

      <Divider />

      {/* TRUST & MISSION */}
      <section className="py-20">
        <Container>
          <div className="max-w-3xl mx-auto text-center space-y-8">
            <h2 className="font-serif text-4xl md:text-5xl lowercase">
              why people trust us
            </h2>
            <div className="grid sm:grid-cols-2 gap-6 text-left max-w-2xl mx-auto">
              <div className="space-y-2">
                <p className="font-medium">Rancher verification</p>
                <p className="text-sm text-saddle">Direct outreach, partnership agreement signed, USDA-processor verified for every ranch in our network.</p>
              </div>
              <div className="space-y-2">
                <p className="font-medium">Buyer vetting</p>
                <p className="text-sm text-saddle">Every buyer passes a short qualification quiz — we match intent, location, and order type before any introduction is made.</p>
              </div>
              <div className="space-y-2">
                <p className="font-medium">BHC Promise</p>
                <p className="text-sm text-saddle">Refundable until your rancher accepts. Cold-chain guarantee. We mediate any dispute. <a href="/promise" className="underline hover:text-charcoal">Read the promise →</a></p>
              </div>
              <div className="space-y-2">
                <p className="font-medium">Real support</p>
                <p className="text-sm text-saddle">Run by a real person, not a faceless platform. Questions get answered. Problems get solved.</p>
              </div>
            </div>
          </div>
        </Container>
      </section>

      <Divider />

      {/* FINAL CTA */}
      <section className="py-24 bg-saddle text-bone">
        <Container>
          <div className="text-center space-y-8">
            <h2 className="font-serif text-4xl md:text-5xl lowercase">
              get started
            </h2>
            <p className="text-xl max-w-2xl mx-auto">
              {totalMembers
                ? `${totalMembers.toLocaleString()}+ people already matched. The quiz takes 90 seconds.`
                : 'Take the 90-second quiz. Most buyers are matched within hours.'}
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center pt-6">
              <Button
                href="/access"
                size="lg"
                className="bg-bone text-charcoal border-bone hover:bg-white hover:border-white"
              >
                join as a buyer
              </Button>
              <Button
                href="/sell"
                size="lg"
                className="bg-transparent text-bone border-bone hover:bg-bone hover:text-charcoal"
              >
                sell as a rancher
              </Button>
              <Button
                href="https://merch.buyhalfcow.com/collections/hats?utm_source=buyhalfcow&utm_medium=cta&utm_campaign=hat-launch"
                external
                size="lg"
                className="bg-transparent text-bone border-bone hover:bg-bone hover:text-charcoal"
              >
                shop hats
              </Button>
            </div>
            <p className="text-sm pt-4 text-dust">
              Questions? <a href="mailto:contact@buyhalfcow.com" className="underline">contact@buyhalfcow.com</a>
            </p>
          </div>
        </Container>
      </section>

      <Divider />
      </main>
  );
}
