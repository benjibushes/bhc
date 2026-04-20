'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import Container from './Container';
import Divider from './Divider';
import Button from './Button';

function CampaignTracker() {
  const searchParams = useSearchParams();

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
  }, [searchParams]);

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

            {stats && (
              <div className="flex justify-center gap-6 md:gap-10 pt-6">
                <div className="text-center">
                  <div className="font-serif text-3xl md:text-4xl">{stats.buyerCount.toLocaleString()}</div>
                  <div className="text-xs uppercase tracking-wider text-saddle">Members</div>
                </div>
                <div className="w-px bg-dust" />
                <div className="text-center">
                  <div className="font-serif text-3xl md:text-4xl">{stats.rancherCount}</div>
                  <div className="text-xs uppercase tracking-wider text-saddle">Ranchers</div>
                </div>
                <div className="w-px bg-dust" />
                <div className="text-center">
                  <div className="font-serif text-3xl md:text-4xl">{stats.stateCount}</div>
                  <div className="text-xs uppercase tracking-wider text-saddle">States</div>
                </div>
              </div>
            )}

            <p className="text-sm text-saddle pt-2">
              Follow the movement:{' '}
              <a href="https://instagram.com/buyhalfcow" target="_blank" rel="noopener noreferrer" className="underline hover:text-charcoal transition-colors">@buyhalfcow</a>
            </p>
          </div>
        </Container>
      </section>

      <Divider />

      {/* WHO THIS IS FOR - Crystal Clear Paths */}
      <section className="py-20">
        <Container>
          <div className="text-center mb-16">
            <h2 className="font-serif text-3xl md:text-4xl mb-4">
              Pick Your Path
            </h2>
            <p className="text-lg text-saddle">
              Choose what describes you best
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8 max-w-7xl mx-auto">
            {/* PATH 1: CONSUMERS / BUYERS */}
            <div className="border-2 border-charcoal p-8 space-y-6 hover:bg-white transition-colors">
              <div className="text-center">
                <div className="text-5xl mb-4">🥩</div>
                <h3 className="font-serif text-2xl mb-2">I Want to Source Beef</h3>
                <p className="text-sm text-saddle mb-6">
                  Join The HERD and source directly from verified American ranchers
                </p>
              </div>
              <div className="space-y-3 text-sm">
                <p className="flex items-start">
                  <span className="mr-2">✓</span>
                  <span>Verified ranchers in your state</span>
                </p>
                <p className="flex items-start">
                  <span className="mr-2">✓</span>
                  <span>Personal introductions</span>
                </p>
                <p className="flex items-start">
                  <span className="mr-2">✓</span>
                  <span>Join {totalMembers ? `${totalMembers.toLocaleString()}+` : 'hundreds of'} members sourcing direct</span>
                </p>
              </div>
              <Button href="/access" className="w-full">
                Join The HERD
              </Button>
            </div>

            {/* PATH 2: RANCHERS */}
            <div className="border-2 border-charcoal p-8 space-y-6 hover:bg-white transition-colors">
              <div className="text-center">
                <div className="text-5xl mb-4">🤠</div>
                <h3 className="font-serif text-2xl mb-2">I'm a Rancher</h3>
                <p className="text-sm text-saddle mb-6">
                  Join American ranchers serving The HERD
                </p>
              </div>
              <div className="space-y-3 text-sm">
                <p className="flex items-start">
                  <span className="mr-2">✓</span>
                  <span>Verified buyers only</span>
                </p>
                <p className="flex items-start">
                  <span className="mr-2">✓</span>
                  <span>In-person ranch certification</span>
                </p>
                <p className="flex items-start">
                  <span className="mr-2">✓</span>
                  <span>Direct sales, no spam</span>
                </p>
              </div>
              <Button href="/partner" className="w-full">
                Apply to Join Network
              </Button>
            </div>

            {/* PATH 3: LAND SELLERS */}
            <div className="border-2 border-charcoal p-8 space-y-6 hover:bg-white transition-colors">
              <div className="text-center">
                <div className="text-5xl mb-4">🏞️</div>
                <h3 className="font-serif text-2xl mb-2">I Have Land</h3>
                <p className="text-sm text-saddle mb-6">
                  Selling ranch property, hunting land, or acreage privately
                </p>
              </div>
              <div className="space-y-3 text-sm">
                <p className="flex items-start">
                  <span className="mr-2">✓</span>
                  <span>Serious buyers only</span>
                </p>
                <p className="flex items-start">
                  <span className="mr-2">✓</span>
                  <span>No public listing spam</span>
                </p>
                <p className="flex items-start">
                  <span className="mr-2">✓</span>
                  <span>Direct contact info shared</span>
                </p>
              </div>
              <Button href="/partner" className="w-full">
                List Land Deal
              </Button>
            </div>

            {/* PATH 4: BRANDS */}
            <div className="border-2 border-charcoal p-8 space-y-6 hover:bg-white transition-colors">
              <div className="text-center">
                <div className="text-5xl mb-4">🛠️</div>
                <h3 className="font-serif text-2xl mb-2">I'm a Brand</h3>
                <p className="text-sm text-saddle mb-6">
                  Western/ranch brand wanting to reach engaged members
                </p>
              </div>
              <div className="space-y-3 text-sm">
                <p className="flex items-start">
                  <span className="mr-2">✓</span>
                  <span>Promote to members</span>
                </p>
                <p className="flex items-start">
                  <span className="mr-2">✓</span>
                  <span>Offer exclusive discounts</span>
                </p>
                <p className="flex items-start">
                  <span className="mr-2">✓</span>
                  <span>Aligned audience</span>
          </p>
        </div>
              <Button href="/partner" className="w-full">
                Partner With Us
              </Button>
            </div>
          </div>
        </Container>
      </section>

      <Divider />

      {/* MERCH SECTION - Signal of Belief */}
      <section className="py-20 bg-charcoal text-bone">
        <Container>
          <div className="text-center space-y-8">
            <h2 className="font-serif text-4xl md:text-5xl">
              Wear The Signal
            </h2>
            <p className="text-xl text-dust max-w-2xl mx-auto leading-relaxed">
              Limited Sackett Ranch collab. If you're wearing this, you were early.<br />
              <strong className="text-bone">This is how we prove demand to ranchers — and fund the first partnerships.</strong>
            </p>
            
            <div className="pt-6">
              <a 
                href="https://www.sackett-ranch.com/pages/buy-half-cow" 
            target="_blank"
            rel="noopener noreferrer"
                className="inline-block px-12 py-5 bg-bone text-charcoal hover:bg-dust hover:text-bone transition-colors duration-300 font-medium tracking-wider uppercase text-base border-2 border-bone"
              >
                Get Yours →
              </a>
            </div>

            <p className="text-sm text-dust pt-4">
              HERD members only. Sells out fast.
            </p>
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
                href="https://www.sackett-ranch.com/pages/buy-half-cow"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block px-10 py-5 bg-transparent text-bone hover:bg-bone hover:text-charcoal transition-colors duration-300 font-medium tracking-wider uppercase border-2 border-bone"
              >
                Shop Merch
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
              <Button href="/faq" variant="secondary">FAQ</Button>
              <Button href="/about" variant="secondary">About</Button>
              <Button href="/news" variant="secondary">News</Button>
              <Button href="https://www.sackett-ranch.com/pages/buy-half-cow" variant="secondary">Merch</Button>
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
