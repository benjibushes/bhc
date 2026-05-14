'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import Container from './Container';
import Divider from './Divider';
import Button from './Button';
import LiveCounter from './LiveCounter';

function CampaignTracker() {
  const searchParams = useSearchParams();
  // Depend on serialized string so the effect runs once per actual URL
  // change instead of every render (useSearchParams() returns a fresh
  // object each render).
  const searchParamsString = searchParams.toString();

  useEffect(() => {
    const campaign = searchParams.get('campaign');
    const source = searchParams.get('source') || searchParams.get('utm_source');
    const ref = searchParams.get('ref') || searchParams.get('aff');
    const utmParams = searchParams.toString();

    if (campaign) {
      localStorage.setItem('bhc_campaign', campaign);
      localStorage.setItem('bhc_source', source || 'email');
    } else if (source) {
      localStorage.setItem('bhc_source', source);
    }

    if (ref) {
      localStorage.setItem('bhc_ref', ref);
    }

    if (utmParams) {
      localStorage.setItem('bhc_utm_params', utmParams);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParamsString]);

  return null;
}

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
      <Suspense fallback={null}>
        <CampaignTracker />
      </Suspense>
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

            <h1 className="font-serif text-4xl md:text-6xl lg:text-7xl leading-tight">
              {totalMembers
                ? <>{totalMembers.toLocaleString()}+ Members<br />Rebuilding Real Food</>
                : <>A Private Network<br />Rebuilding Real Food</>}
            </h1>

            <p className="text-xl md:text-2xl max-w-2xl mx-auto leading-relaxed text-saddle">
              A private membership network connecting Americans directly with verified local ranchers. No middlemen. No algorithms. Just trust.
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
            <h2 className="font-serif text-3xl md:text-4xl mb-4">
              Source beef directly from a real ranch
            </h2>
            <p className="text-lg text-saddle mb-10">
              We connect you with a verified rancher in your state — quarter, half, or whole cow,
              processed and packaged the way local families have been doing it for generations.
              {totalMembers ? ` Join ${totalMembers.toLocaleString()}+ members already sourcing direct.` : ''}
            </p>
            <Button href="/access" className="text-base">
              Get Access to the Network
            </Button>
            <p className="text-xs text-saddle mt-8">
              Are you a rancher, brand, or have land to list?{' '}
              <a href="/partner" className="underline hover:text-charcoal transition-colors">
                Partner with us instead
              </a>
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
                Public hit list of ranchers shipping direct to families. Find one near you, or
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
              <p className="text-xs uppercase tracking-[0.3em] text-dust">New Drop</p>
              <h2 className="font-serif text-4xl md:text-5xl">
                Rep The Herd
              </h2>
              <p className="text-lg text-dust leading-relaxed">
                Trucker hats made for ranchers, beef lovers, and anyone who knows
                where their food comes from.
                <br />
                <strong className="text-bone">Free shipping over $35. Ships in 5–7 days.</strong>
              </p>

              <div className="pt-2">
                <a
                  href="https://merch.buyhalfcow.com/collections/hats?utm_source=buyhalfcow&utm_medium=homepage-hero&utm_campaign=hat-launch"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block px-12 py-5 bg-bone text-charcoal hover:bg-dust hover:text-bone transition-colors duration-300 font-medium tracking-wider uppercase text-base border-2 border-bone"
                >
                  🧢 Shop Hats →
                </a>
              </div>
              <p className="text-sm text-dust">
                HERD members only. Sells out fast.
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
              <h2 className="font-serif text-4xl md:text-5xl mb-6">
                How We're Different
              </h2>
              <p className="text-xl leading-relaxed text-saddle">
                BuyHalfCow is the only <strong className="text-charcoal">private, approval-only</strong> network for sourcing ranch beef direct. Every rancher is verified. Every buyer is vetted. Every connection is logged.
              </p>
            </div>

            <Divider />

            <div className="grid md:grid-cols-3 gap-8">
              <div className="text-center space-y-4">
                <div className="text-4xl">01</div>
                <h3 className="font-serif text-xl">Approval-Only Access</h3>
                <p className="text-sm text-saddle leading-relaxed">
                  Every member is manually reviewed before joining. No bots, no spam, no tire-kickers.
                </p>
              </div>
              <div className="text-center space-y-4">
                <div className="text-4xl">02</div>
                <h3 className="font-serif text-xl">Verified Ranchers</h3>
                <p className="text-sm text-saddle leading-relaxed">
                  We certify ranchers through direct outreach and verification. Only real operations make the network.
                </p>
              </div>
              <div className="text-center space-y-4">
                <div className="text-4xl">03</div>
                <h3 className="font-serif text-xl">Direct Relationships</h3>
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
            <h2 className="font-serif text-4xl md:text-5xl mb-4">
              How It Works
            </h2>
          </div>

          <div className="max-w-5xl mx-auto space-y-16">
            {/* For Buyers */}
            <div className="space-y-6">
              <h3 className="font-serif text-3xl text-center mb-8">For Buyers (Consumers)</h3>
              <div className="grid md:grid-cols-4 gap-6">
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">1</div>
                  <p className="font-medium">Apply</p>
                  <p className="text-sm text-saddle">Fill out 2-min form. We review manually.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">2</div>
                  <p className="font-medium">Get Approved</p>
                  <p className="text-sm text-saddle">Email confirmation + member access within 24 hours.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">3</div>
                  <p className="font-medium">Browse Ranchers</p>
                  <p className="text-sm text-saddle">Filter by your state. See capacity, beef types.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">4</div>
                  <p className="font-medium">Contact Direct</p>
                  <p className="text-sm text-saddle">Message rancher. Work out details. Done.</p>
                </div>
              </div>
            </div>

            <Divider />

            {/* For Ranchers */}
            <div className="space-y-6">
              <h3 className="font-serif text-3xl text-center mb-8">For Ranchers</h3>
              <div className="grid md:grid-cols-4 gap-6">
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">1</div>
                  <p className="font-medium">Apply</p>
                  <p className="text-sm text-saddle">Submit ranch info, capacity, certifications.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">2</div>
                  <p className="font-medium">Get Certified</p>
                  <p className="text-sm text-saddle">We verify and approve. Listed as "Certified".</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">3</div>
                  <p className="font-medium">Receive Inquiries</p>
                  <p className="text-sm text-saddle">Qualified buyers contact you directly via email.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal text-bone rounded-full flex items-center justify-center font-serif text-xl mx-auto">4</div>
                  <p className="font-medium">Complete Sale</p>
                  <p className="text-sm text-saddle">Keep 90%. We take 10% on successful sales.</p>
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
            <h2 className="font-serif text-4xl md:text-5xl">
              Why People Trust Us
            </h2>
            <div className="grid sm:grid-cols-2 gap-6 text-left max-w-2xl mx-auto">
              <div className="space-y-2">
                <p className="font-medium">Rancher Verification</p>
                <p className="text-sm text-saddle">Direct outreach, documentation review, and ongoing accountability for every ranch in our network.</p>
              </div>
              <div className="space-y-2">
                <p className="font-medium">Buyer Vetting</p>
                <p className="text-sm text-saddle">Every application is reviewed. We match intent, location, and order type before any introduction is made.</p>
              </div>
              <div className="space-y-2">
                <p className="font-medium">Logged Connections</p>
                <p className="text-sm text-saddle">Every referral, introduction, and follow-up is tracked in our CRM. Nothing falls through the cracks.</p>
              </div>
              <div className="space-y-2">
                <p className="font-medium">Real Support</p>
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
            <h2 className="font-serif text-4xl md:text-5xl">
              Get Started
            </h2>
            <p className="text-xl max-w-2xl mx-auto">
              {totalMembers
                ? `${totalMembers.toLocaleString()}+ people are already in. Applications reviewed daily.`
                : 'Applications reviewed daily. Most members are approved within 24 hours.'}
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center pt-6">
              <a
                href="/access"
                className="inline-block px-10 py-5 bg-bone text-charcoal hover:bg-white transition-colors duration-300 font-medium tracking-wider uppercase border-2 border-bone"
              >
                Join as a Buyer
              </a>
              <a
                href="/partner"
                className="inline-block px-10 py-5 bg-transparent text-bone hover:bg-bone hover:text-charcoal transition-colors duration-300 font-medium tracking-wider uppercase border-2 border-bone"
              >
                Apply as a Rancher
              </a>
              <a
                href="https://merch.buyhalfcow.com/collections/hats?utm_source=buyhalfcow&utm_medium=cta&utm_campaign=hat-launch"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block px-10 py-5 bg-transparent text-bone hover:bg-bone hover:text-charcoal transition-colors duration-300 font-medium tracking-wider uppercase border-2 border-bone"
              >
                🧢 Shop Hats
              </a>
            </div>
            <p className="text-sm pt-4 text-dust">
              Questions? <a href="mailto:contact@buyhalfcow.com" className="underline">contact@buyhalfcow.com</a>
            </p>
          </div>
        </Container>
      </section>

      <Divider />

      {/* FOOTER */}
      <footer className="py-12">
        <Container>
          <div className="text-center space-y-6">
            <div className="flex flex-wrap justify-center gap-4 text-sm">
              <Button href="/map" variant="secondary">Map</Button>
              <Button href="/wins" variant="secondary">Wins</Button>
              <Button href="/founders" variant="secondary">Founders</Button>
              <Button href="/brand-partners" variant="secondary">Brand Partners</Button>
              <Button href="/map/add-a-rancher" variant="secondary">Add a Rancher</Button>
              <Button href="/faq" variant="secondary">FAQ</Button>
              <Button href="/about" variant="secondary">About</Button>
              <Button href="/news" variant="secondary">News</Button>
              <Button href="https://merch.buyhalfcow.com/collections/hats?utm_source=buyhalfcow&utm_medium=footer&utm_campaign=hat-launch" variant="secondary">🧢 Hats</Button>
              <Button href="/member/login" variant="secondary">Member Login</Button>
              <Button href="/rancher/login" variant="secondary">Rancher Login</Button>
            </div>
            
            <Divider />

            <div className="flex flex-wrap justify-center gap-6 text-xs text-dust">
              <a href="/terms" className="hover:text-charcoal transition-colors">Terms</a>
              <a href="/privacy" className="hover:text-charcoal transition-colors">Privacy</a>
            </div>
            
            <div className="space-y-2 text-sm text-dust">
              <p>BuyHalfCow is a private, approval-only network for sourcing ranch beef direct.</p>
              <p>Kalispell, MT &middot; <a href="https://instagram.com/buyhalfcow" target="_blank" rel="noopener noreferrer" className="hover:text-charcoal transition-colors">@buyhalfcow</a></p>
            </div>
          </div>
        </Container>
      </footer>
      </main>
  );
}
