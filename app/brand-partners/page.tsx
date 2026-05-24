import type { Metadata } from 'next';
import Container from '../components/Container';
import Pill from '../components/Pill';
import BrandTierCTA, { BrandPartnersViewTracker } from './BrandTierCTA';

// Tiered brand partner offer. Brands pay to be featured in the BuyHalfCow
// network — logo placement, posts on the IG / founder list, pinned in
// marketing material.
//
// $99  Spotlight  → Stripe Payment Link (NEXT_PUBLIC_BRAND_SPOTLIGHT_LINK)
// $499 Featured   → Stripe Payment Link (NEXT_PUBLIC_BRAND_FEATURED_LINK)
// $1,500 Founding → Calendly (NEXT_PUBLIC_BRAND_FOUNDING_CALENDLY) — intentional
//                   friction for high-ticket; forces qualification call.
//
// Operator follow-up after deploy:
//   1. Create 2 Stripe Payment Links in Stripe Dashboard ($99 + $499)
//   2. Set NEXT_PUBLIC_BRAND_SPOTLIGHT_LINK + NEXT_PUBLIC_BRAND_FEATURED_LINK in Vercel
//   3. Set NEXT_PUBLIC_BRAND_FOUNDING_CALENDLY in Vercel
//   4. Configure success URLs → /brand-partners/welcome?session_id={CHECKOUT_SESSION_ID}
//   5. Extend /api/webhooks/stripe to handle metadata.type=brand-partner
//      (create Airtable BrandPartners row + send welcome email + Telegram alert)

export const metadata: Metadata = {
  title: 'Brand Partners — Get in front of the BuyHalfCow network',
  description:
    'Three tiers, real distribution. Get your brand in front of D2C ranchers + the families who buy their beef. Logo placement, posts, pinned features.',
};

// NEXT_PUBLIC_ vars are inlined at build time — safe to read here in a
// Server Component because Next.js bakes them in at compile time.
const spotlightLink =
  process.env.NEXT_PUBLIC_BRAND_SPOTLIGHT_LINK || '#contact';
const featuredLink =
  process.env.NEXT_PUBLIC_BRAND_FEATURED_LINK || '#contact';
const foundingCalendly =
  process.env.NEXT_PUBLIC_BRAND_FOUNDING_CALENDLY || 'https://buyhalfcow.com/call';

// TODO: wire real Airtable count via /api/stats/public once endpoint exposes
// founding_brand_partners_remaining. For now hardcode 5.
const FOUNDING_SPOTS_REMAINING: number = 5;

export default function BrandPartnersPage() {
  return (
    <main className="min-h-screen bg-bone text-charcoal">
      {/* Page-view tracking — client component, no render output */}
      <BrandPartnersViewTracker />

      {/* HERO */}
      <section className="py-20 md:py-28">
        <Container>
          <div className="max-w-3xl mx-auto text-center space-y-5">
            <Pill tone="neutral" className="mx-auto">Brand Partners</Pill>
            <h1 className="font-serif text-4xl md:text-6xl leading-tight">
              Get your brand in front of the people who built America.
            </h1>
            <p className="text-lg md:text-xl text-charcoal/80 leading-relaxed max-w-2xl mx-auto">
              D2C ranchers. Their families. The buyers who chose real beef over
              grocery-chain commodity. The Founding Herd. If your brand belongs
              in front of this network, three ways in.
            </p>
            <div className="pt-2">
              <a
                href="#tiers"
                className="inline-flex items-center gap-2 px-7 py-3.5 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase transition-base hover:bg-divider"
              >
                See the tiers
              </a>
            </div>
          </div>
        </Container>
      </section>

      {/* WHO BELONGS */}
      <section className="py-12 bg-bone-warm border-y border-dust">
        <Container>
          <div className="max-w-4xl mx-auto space-y-6 text-center">
            <Pill tone="neutral" className="mx-auto">Who fits</Pill>
            <p className="text-base md:text-lg text-charcoal/85 leading-relaxed max-w-3xl mx-auto">
              Coolers, knives, cutting boards, freezer chests, regen-ag input
              brands, ranching media, family food brands, vacuum sealers, jerky
              kits, anything a D2C beef rancher or beef-buying family would
              actually use. If you sell to ranchers OR to people who buy ranch
              beef, you fit.
            </p>
            <p className="text-sm text-saddle italic">
              No fast food, no commodity beef brands, no Tyson-adjacent. We
              gate carefully — fit matters more than spend.
            </p>
          </div>
        </Container>
      </section>

      {/* TIERS */}
      <section id="tiers" className="py-16 md:py-24">
        <Container>
          <div className="max-w-3xl mx-auto text-center mb-10 md:mb-12 space-y-3">
            <h2 className="font-serif text-3xl md:text-5xl">Three ways in</h2>
            <p className="text-saddle max-w-xl mx-auto">
              Pick the tier that fits your goals. We'll reach out within 24h of
              payment to confirm fit and kick off the deliverables.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-5 md:gap-6 max-w-5xl mx-auto">

            {/* ── Spotlight — $99/month ── */}
            <article className="p-7 md:p-8 space-y-6 flex flex-col bg-bone border border-dust hover:border-charcoal transition-base">
              <header className="space-y-1.5">
                <p className="text-[11px] uppercase tracking-[0.18em] text-saddle font-semibold">
                  Brand · Spotlight
                </p>
                <p className="font-serif text-3xl text-charcoal leading-tight">
                  Spotlight
                </p>
                <p className="text-base text-charcoal font-medium">
                  $99 <span className="text-saddle font-normal">per month</span>
                </p>
              </header>
              <ul className="text-sm text-charcoal/85 space-y-2.5 leading-relaxed flex-1">
                {[
                  '1 month logo placement on /brand-partners rotating spotlight',
                  'Featured in 1 founder broadcast email (~1,000 backers + buyers)',
                  'Co-branded social post on @buyhalfcow',
                  'Counts toward "trusted partner" badge after 3 months',
                ].map((b, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span aria-hidden className="text-sage shrink-0 mt-0.5">✓</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              <BrandTierCTA
                tier="spotlight"
                href={spotlightLink}
                label="claim spotlight — $99"
              />
            </article>

            {/* ── Featured — $499/quarter ── */}
            <article className="p-7 md:p-8 space-y-6 flex flex-col bg-bone-warm border-2 border-charcoal hover:border-charcoal transition-base">
              <header className="space-y-1.5">
                <p className="text-[11px] uppercase tracking-[0.18em] text-saddle font-semibold">
                  Brand · Featured
                </p>
                <p className="font-serif text-3xl text-charcoal leading-tight">
                  Featured
                </p>
                <p className="text-base text-charcoal font-medium">
                  $499 <span className="text-saddle font-normal">per quarter</span>
                </p>
              </header>
              <ul className="text-sm text-charcoal/85 space-y-2.5 leading-relaxed flex-1">
                {[
                  'Logo + 100-word brand story on /brand-partners',
                  'Featured in 3 founder broadcast emails over the quarter',
                  '2 co-branded social posts on @buyhalfcow',
                  'Brand spotlight slot at /matched success page (post-rancher-intro)',
                  'Listed in "trusted partners" section of the platform',
                ].map((b, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span aria-hidden className="text-sage shrink-0 mt-0.5">✓</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              <BrandTierCTA
                tier="featured"
                href={featuredLink}
                label="claim featured — $499"
              />
            </article>

            {/* ── Founding Brand Partner — $1,500/quarter ── */}
            <article className="p-7 md:p-8 space-y-6 flex flex-col bg-bone border border-dust hover:border-charcoal transition-base">
              <header className="space-y-1.5">
                <p className="text-[11px] uppercase tracking-[0.18em] text-saddle font-semibold">
                  Brand · Founding
                </p>
                <p className="font-serif text-3xl text-charcoal leading-tight">
                  Founding Brand Partner
                </p>
                <p className="text-base text-charcoal font-medium">
                  $1,500 <span className="text-saddle font-normal">per quarter</span>
                </p>
                {/* Scarcity counter — TODO: wire real count from /api/stats/public
                    once endpoint exposes founding_brand_partners_remaining */}
                <p className="text-xs font-semibold text-saddle uppercase tracking-wide pt-0.5">
                  {FOUNDING_SPOTS_REMAINING} spot{FOUNDING_SPOTS_REMAINING !== 1 ? 's' : ''} remaining
                </p>
              </header>
              <ul className="text-sm text-charcoal/85 space-y-2.5 leading-relaxed flex-1">
                {[
                  'Everything in Featured PLUS',
                  'Permanent founders wall placement (your brand alongside the founding 100)',
                  '1-on-1 call with Ben quarterly to strategize',
                  'First access to new rancher cohorts in your category',
                  'Featured slot in monthly investor update letter',
                  '5 spots total — first-come, first-served',
                ].map((b, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span aria-hidden className="text-sage shrink-0 mt-0.5">✓</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              <BrandTierCTA
                tier="founding"
                href={foundingCalendly}
                label="book a 30-min call"
              />
            </article>

          </div>

          <p className="text-center text-xs text-dust mt-8">
            Different need? Custom co-build, exclusive product launch, founding
            sponsor for a state expansion?{' '}
            <a
              href="mailto:ben@buyhalfcow.com?subject=Custom brand partnership"
              className="underline underline-offset-2 hover:text-charcoal"
            >
              ben@buyhalfcow.com
            </a>
          </p>
        </Container>
      </section>

      {/* FAQ */}
      <section className="py-14 bg-bone-warm border-t border-dust">
        <Container>
          <div className="max-w-3xl mx-auto space-y-6">
            <h2 className="font-serif text-2xl md:text-3xl text-charcoal">
              Quick questions
            </h2>
            <div className="space-y-5">
              {[
                {
                  q: 'How big is the network right now?',
                  a: 'Verified rancher partners across multiple states + a Founding Herd of paid backers + the buyer list. Specific numbers in the email after you sign up — we update them honestly.',
                },
                {
                  q: "What if you don't think we're a fit?",
                  a: "We refund within 7 days, no fight. Fit > revenue. We've walked away from sponsors twice already.",
                },
                {
                  q: 'Can we cancel any time?',
                  a: 'Yes. Stripe handles cancellation directly. Stop showing up in deliverables the next month.',
                },
                {
                  q: 'Will you exclusive a category?',
                  a: "Founding Brand Partners get soft-exclusivity in their category for the quarter they pay. Featured + Spotlight don't — we may run a competing brand in the same space.",
                },
                {
                  q: 'Can we pay annually?',
                  a: "Yes — email and we'll send an invoice for 12× monthly with a 1-month discount baked in.",
                },
              ].map((item) => (
                <div key={item.q} className="border-b border-dust/60 pb-4">
                  <h3 className="font-serif text-lg text-charcoal mb-1.5">
                    {item.q}
                  </h3>
                  <p className="text-sm text-charcoal/85 leading-relaxed">{item.a}</p>
                </div>
              ))}
            </div>
            <p className="text-sm text-saddle text-center pt-4">
              Other questions? Email{' '}
              <a
                href="mailto:ben@buyhalfcow.com"
                className="underline underline-offset-2 hover:text-charcoal"
              >
                ben@buyhalfcow.com
              </a>
            </p>
          </div>
        </Container>
      </section>
    </main>
  );
}
