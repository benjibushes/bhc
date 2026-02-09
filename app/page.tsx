'use client';

import { useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Container from './components/Container';
import Divider from './components/Divider';
import Button from './components/Button';
import Image from 'next/image';

function CampaignTracker() {
  const searchParams = useSearchParams();

  useEffect(() => {
    // Capture campaign parameter from URL
    const campaign = searchParams.get('campaign');
    const source = searchParams.get('source') || searchParams.get('utm_source');
    const medium = searchParams.get('utm_medium');
    const utmParams = searchParams.toString();

    if (campaign) {
      localStorage.setItem('bhc_campaign', campaign);
      localStorage.setItem('bhc_source', source || 'email');
    } else if (source) {
      localStorage.setItem('bhc_source', source);
    }

    if (utmParams) {
      localStorage.setItem('bhc_utm_params', utmParams);
    }
  }, [searchParams]);

  return null;
}

export default function HomePage() {
  return (
    <main className="min-h-screen bg-bone-white text-charcoal-black">
      <Suspense fallback={null}>
        <CampaignTracker />
      </Suspense>
      {/* Logo + Hero */}
      <section className="py-12 md:py-20">
        <Container>
          <div className="text-center space-y-8">
            {/* Logo */}
            <div className="flex justify-center mb-8">
              <div className="w-32 h-32 md:w-40 md:h-40 relative">
                {/* Placeholder for logo - replace with actual logo */}
                <div className="w-full h-full flex items-center justify-center">
                  <span className="font-serif text-6xl md:text-7xl">BHC</span>
                </div>
              </div>
            </div>

            {/* Hero Headline */}
            <h1 className="font-serif text-4xl md:text-6xl lg:text-7xl leading-tight">
              Join 15,000+ HERD Members<br />
              Sourcing Real American Beef
          </h1>
            
            <p className="text-xl md:text-2xl max-w-2xl mx-auto leading-relaxed text-saddle-brown">
              200+ verified ranchers. 30+ states. No middleman.<br />
              Direct access to American ranches.<br />
              Built on trust, verification, and real relationships.
            </p>

            <div className="pt-8">
              <div className="inline-block px-6 py-3 bg-[#0E0E0E] text-[#F4F1EC] text-sm font-medium tracking-wide uppercase">
                🚀 LAUNCH WEEK — Applications reviewed in 24 hours
              </div>
            </div>
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
            <p className="text-lg text-saddle-brown">
              Choose what describes you best
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8 max-w-7xl mx-auto">
            {/* PATH 1: CONSUMERS / BUYERS */}
            <div className="border-2 border-charcoal-black p-8 space-y-6 hover:bg-white transition-colors">
              <div className="text-center">
                <div className="text-5xl mb-4">🥩</div>
                <h3 className="font-serif text-2xl mb-2">I Want to Source Beef</h3>
                <p className="text-sm text-saddle-brown mb-6">
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
                  <span>Join 15,000+ HERD members</span>
                </p>
              </div>
              <Button href="/access" className="w-full">
                Join The HERD
              </Button>
            </div>

            {/* PATH 2: RANCHERS */}
            <div className="border-2 border-charcoal-black p-8 space-y-6 hover:bg-white transition-colors">
              <div className="text-center">
                <div className="text-5xl mb-4">🤠</div>
                <h3 className="font-serif text-2xl mb-2">I'm a Rancher</h3>
                <p className="text-sm text-saddle-brown mb-6">
                  Join 200+ American ranchers serving The HERD
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
            <div className="border-2 border-charcoal-black p-8 space-y-6 hover:bg-white transition-colors">
              <div className="text-center">
                <div className="text-5xl mb-4">🏞️</div>
                <h3 className="font-serif text-2xl mb-2">I Have Land</h3>
                <p className="text-sm text-saddle-brown mb-6">
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
            <div className="border-2 border-charcoal-black p-8 space-y-6 hover:bg-white transition-colors">
              <div className="text-center">
                <div className="text-5xl mb-4">🛠️</div>
                <h3 className="font-serif text-2xl mb-2">I'm a Brand</h3>
                <p className="text-sm text-saddle-brown mb-6">
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

      {/* MERCH SECTION - Revenue Driver */}
      <section className="py-20 bg-charcoal-black text-bone-white">
        <Container>
          <div className="text-center space-y-8">
            <h2 className="font-serif text-4xl md:text-5xl">
              BuyHalfCow Merch
            </h2>
            <p className="text-xl text-dust-gray max-w-2xl mx-auto">
              Western apparel and ranch gear.<br />
              <strong className="text-bone-white">Open to everyone</strong> — no membership required.
            </p>
            
            <div className="pt-6">
              <a 
                href="https://merch.buyhalfcow.com" 
            target="_blank"
            rel="noopener noreferrer"
                className="inline-block px-12 py-5 bg-bone-white text-charcoal-black hover:bg-dust-gray hover:text-bone-white transition-colors duration-300 font-medium tracking-wider uppercase text-base border-2 border-bone-white"
              >
                Shop Now →
              </a>
            </div>

            <p className="text-sm text-dust-gray pt-4">
              Members get 20% off everything + early drop access
            </p>
          </div>
        </Container>
      </section>

      <Divider />

      {/* WHAT IS BUYHALFCOW - Clear Explanation */}
      <section className="py-20">
        <Container>
          <div className="max-w-4xl mx-auto space-y-12">
            <div className="text-center">
              <h2 className="font-serif text-4xl md:text-5xl mb-6">
                What BuyHalfCow Is
              </h2>
              <p className="text-xl leading-relaxed text-saddle-brown">
                A <strong className="text-charcoal-black">private membership network</strong> connecting people who want to source ranch beef directly — and ranchers who want qualified buyers without the noise.
              </p>
            </div>

            <Divider />

            {/* The Problem */}
            <div className="grid md:grid-cols-2 gap-12">
              <div className="space-y-4">
                <h3 className="font-serif text-2xl text-weathered-red">The Problem</h3>
                <ul className="space-y-3 text-base leading-relaxed">
                  <li className="flex items-start">
                    <span className="mr-3 text-weathered-red">✗</span>
                    <span>Public marketplaces are full of spam</span>
                  </li>
                  <li className="flex items-start">
                    <span className="mr-3 text-weathered-red">✗</span>
                    <span>Buyers don't know who to trust</span>
                  </li>
                  <li className="flex items-start">
                    <span className="mr-3 text-weathered-red">✗</span>
                    <span>Ranchers waste time on tire-kickers</span>
                  </li>
                  <li className="flex items-start">
                    <span className="mr-3 text-weathered-red">✗</span>
                    <span>No accountability or vetting</span>
                  </li>
                </ul>
              </div>

              <div className="space-y-4">
                <h3 className="font-serif text-2xl">Our Solution</h3>
                <ul className="space-y-3 text-base leading-relaxed">
                  <li className="flex items-start">
                    <span className="mr-3 text-charcoal-black font-bold">✓</span>
                    <span><strong>Manual approval</strong> for all members</span>
                  </li>
                  <li className="flex items-start">
                    <span className="mr-3 text-charcoal-black font-bold">✓</span>
                    <span><strong>Certified ranchers</strong> only</span>
                  </li>
                  <li className="flex items-start">
                    <span className="mr-3 text-charcoal-black font-bold">✓</span>
                    <span><strong>Direct connections</strong> — we stay out</span>
                  </li>
                  <li className="flex items-start">
                    <span className="mr-3 text-charcoal-black font-bold">✓</span>
                    <span><strong>CRM-logged</strong> for accountability</span>
                  </li>
                </ul>
              </div>
            </div>

            <Divider />

            {/* What We're NOT */}
            <div className="text-center space-y-6">
              <h3 className="font-serif text-3xl">What We're NOT</h3>
              <div className="grid md:grid-cols-2 gap-4 max-w-2xl mx-auto text-left">
                <p className="flex items-start text-base">
                  <span className="mr-3 text-weathered-red text-xl">✗</span>
                  <span>An e-commerce site with checkout</span>
                </p>
                <p className="flex items-start text-base">
                  <span className="mr-3 text-weathered-red text-xl">✗</span>
                  <span>Open to anyone with an email</span>
                </p>
                <p className="flex items-start text-base">
                  <span className="mr-3 text-weathered-red text-xl">✗</span>
                  <span>A matching algorithm platform</span>
                </p>
                <p className="flex items-start text-base">
                  <span className="mr-3 text-weathered-red text-xl">✗</span>
                  <span>Trying to scale at all costs</span>
                </p>
              </div>
              <p className="text-lg text-saddle-brown pt-4">
                We're small, intentional, and trust-first.
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
                  <div className="w-12 h-12 bg-charcoal-black text-bone-white rounded-full flex items-center justify-center font-serif text-xl mx-auto">1</div>
                  <p className="font-medium">Apply</p>
                  <p className="text-sm text-saddle-brown">Fill out 2-min form. We review manually.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal-black text-bone-white rounded-full flex items-center justify-center font-serif text-xl mx-auto">2</div>
                  <p className="font-medium">Get Approved</p>
                  <p className="text-sm text-saddle-brown">Email confirmation + login access in 3-5 days.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal-black text-bone-white rounded-full flex items-center justify-center font-serif text-xl mx-auto">3</div>
                  <p className="font-medium">Browse Ranchers</p>
                  <p className="text-sm text-saddle-brown">Filter by your state. See capacity, beef types.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal-black text-bone-white rounded-full flex items-center justify-center font-serif text-xl mx-auto">4</div>
                  <p className="font-medium">Contact Direct</p>
                  <p className="text-sm text-saddle-brown">Message rancher. Work out details. Done.</p>
                </div>
              </div>
            </div>

            <Divider />

            {/* For Ranchers */}
            <div className="space-y-6">
              <h3 className="font-serif text-3xl text-center mb-8">For Ranchers</h3>
              <div className="grid md:grid-cols-4 gap-6">
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal-black text-bone-white rounded-full flex items-center justify-center font-serif text-xl mx-auto">1</div>
                  <p className="font-medium">Apply</p>
                  <p className="text-sm text-saddle-brown">Submit ranch info, capacity, certifications.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal-black text-bone-white rounded-full flex items-center justify-center font-serif text-xl mx-auto">2</div>
                  <p className="font-medium">Get Certified</p>
                  <p className="text-sm text-saddle-brown">We verify and approve. Listed as "Certified".</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal-black text-bone-white rounded-full flex items-center justify-center font-serif text-xl mx-auto">3</div>
                  <p className="font-medium">Receive Inquiries</p>
                  <p className="text-sm text-saddle-brown">Qualified buyers contact you directly via email.</p>
                </div>
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 bg-charcoal-black text-bone-white rounded-full flex items-center justify-center font-serif text-xl mx-auto">4</div>
                  <p className="font-medium">Complete Sale</p>
                  <p className="text-sm text-saddle-brown">Keep 90%. We take 10% on successful sales.</p>
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
              Built on Trust
            </h2>
            <p className="text-xl leading-relaxed text-saddle-brown">
              Every rancher is reviewed.<br />
              Every member is approved.<br />
              Every deal is logged in our CRM.
            </p>
            <Divider />
            <p className="text-lg">
              <strong className="text-charcoal-black">This isn't about scale.</strong><br />
              It's about keeping things good.
            </p>
          </div>
        </Container>
      </section>

      <Divider />

      {/* FINAL CTA */}
      <section className="py-24 bg-saddle-brown text-bone-white">
        <Container>
          <div className="text-center space-y-8">
            <h2 className="font-serif text-4xl md:text-5xl">
              Ready?
            </h2>
            <p className="text-xl max-w-2xl mx-auto">
              Choose your path below.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center pt-6">
              <a
                href="/access"
                className="inline-block px-10 py-5 bg-bone-white text-charcoal-black hover:bg-white transition-colors duration-300 font-medium tracking-wider uppercase border-2 border-bone-white"
              >
                I Want Beef
              </a>
              <a
                href="/partner"
                className="inline-block px-10 py-5 bg-transparent text-bone-white hover:bg-bone-white hover:text-charcoal-black transition-colors duration-300 font-medium tracking-wider uppercase border-2 border-bone-white"
              >
                I'm a Partner
          </a>
          <a
                href="https://merch.buyhalfcow.com"
            target="_blank"
            rel="noopener noreferrer"
                className="inline-block px-10 py-5 bg-transparent text-bone-white hover:bg-bone-white hover:text-charcoal-black transition-colors duration-300 font-medium tracking-wider uppercase border-2 border-bone-white"
          >
                Shop Merch
          </a>
        </div>
            <p className="text-sm pt-4 text-dust-gray">
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
              <Button href="https://merch.buyhalfcow.com" variant="secondary">Merch</Button>
              <Button href="/member" variant="secondary">Member Login</Button>
            </div>
            
            <Divider />

            <div className="flex flex-wrap justify-center gap-6 text-xs text-dust-gray">
              <a href="/terms" className="hover:text-charcoal-black transition-colors">Terms</a>
              <a href="/privacy" className="hover:text-charcoal-black transition-colors">Privacy</a>
            </div>
            
            <div className="space-y-2 text-sm text-dust-gray">
              <p>BuyHalfCow is a private membership network.</p>
              <p>Not a marketplace. Not e-commerce.</p>
            </div>
          </div>
        </Container>
      </footer>
      </main>
  );
}
