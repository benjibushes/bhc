import type { Metadata } from 'next';
import Container from '../components/Container';
import Pill from '../components/Pill';
import Card from '../components/Card';

// Tiered brand partner offer. Brands pay to be featured in the BuyHalfCow
// network — logo placement, posts on the IG / founder list, pinned in
// marketing material. Simple Stripe Payment Link buttons. No webhook
// integration in v1 — Ben fulfills manually after each signup (sends the
// Telegram alert via Stripe's email-on-payment, manually triggers each
// deliverable). Once volume warrants it, automate.
//
// Tiers (priced for D2C-aligned brands — coolers, cutting boards, regen
// supplements, ranching media, etc.). Edit pricing here + drop matching
// Payment Links in env vars.

export const metadata: Metadata = {
  title: 'Brand Partners — Get in front of the BuyHalfCow network',
  description:
    'Three tiers, real distribution. Get your brand in front of D2C ranchers + the families who buy their beef. Logo placement, posts, pinned features.',
};

type Tier = {
  id: string;
  name: string;
  price: string;
  cadence: string;
  envKey: string; // env var holding the Stripe Payment Link URL
  bullets: string[];
  emphasis?: boolean;
};

const TIERS: Tier[] = [
  {
    id: 'spotlight',
    name: 'Spotlight',
    price: '$99',
    cadence: 'per month',
    envKey: 'STRIPE_BRAND_LINK_SPOTLIGHT',
    bullets: [
      'Logo on the public Brand Partners page',
      'Listed in the monthly founder letter (~1,000 backers + buyers)',
      'One IG mention per quarter on @buyhalfcow',
      'Discount code listed for the rancher network',
    ],
  },
  {
    id: 'featured',
    name: 'Featured',
    price: '$499',
    cadence: 'per month',
    envKey: 'STRIPE_BRAND_LINK_FEATURED',
    emphasis: true,
    bullets: [
      'Everything in Spotlight',
      'Dedicated post on @buyhalfcow per month',
      'Pinned at top of Brand Partners page',
      'Included in one founder letter spotlight per quarter',
      'First-look on co-marketed campaigns',
    ],
  },
  {
    id: 'co-marketed',
    name: 'Co-marketed',
    price: '$2,500',
    cadence: 'per quarter',
    envKey: 'STRIPE_BRAND_LINK_COMARKETED',
    bullets: [
      'Everything in Featured',
      'Co-branded campaign with BuyHalfCow (you supply the angle, we supply the audience)',
      'Product placement in one rancher partner photo/video shoot',
      'Dedicated email blast to the buyer list',
      'Direct intros to 5 rancher partners for product trials',
    ],
  },
];

export default function BrandPartnersPage() {
  return (
    <main className="min-h-screen bg-bone text-charcoal">
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
              Pick the tier that fits your goals. Cancel any time. We'll reach
              out within 24h of payment to confirm fit and kick off the
              deliverables.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-5 md:gap-6 max-w-5xl mx-auto">
            {TIERS.map((tier) => {
              const link = process.env[tier.envKey] || '';
              return (
                <article
                  key={tier.id}
                  className={`p-7 md:p-8 space-y-6 transition-base flex flex-col ${
                    tier.emphasis
                      ? 'bg-bone-warm border-2 border-charcoal'
                      : 'bg-bone border border-dust'
                  } hover:border-charcoal`}
                >
                  <header className="space-y-1.5">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-saddle font-semibold">
                      Brand · {tier.name}
                    </p>
                    <p className="font-serif text-3xl text-charcoal leading-tight">
                      {tier.name}
                    </p>
                    <p className="text-base text-charcoal font-medium">
                      {tier.price} <span className="text-saddle font-normal">{tier.cadence}</span>
                    </p>
                  </header>
                  <ul className="text-sm text-charcoal/85 space-y-2.5 leading-relaxed flex-1">
                    {tier.bullets.map((b, i) => (
                      <li key={i} className="flex gap-2.5">
                        <span aria-hidden className="text-sage shrink-0 mt-0.5">
                          ✓
                        </span>
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                  {link ? (
                    <a
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-center px-6 py-3.5 text-sm font-medium tracking-wide uppercase bg-charcoal text-bone transition-base hover:bg-divider"
                    >
                      Sign up · {tier.name}
                    </a>
                  ) : (
                    <a
                      href="mailto:ben@buyhalfcow.com?subject=Brand Partner — Interested in [tier]"
                      className="block text-center px-6 py-3.5 text-sm font-medium tracking-wide uppercase bg-charcoal text-bone transition-base hover:bg-divider"
                    >
                      Email to start
                    </a>
                  )}
                </article>
              );
            })}
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
                  q: 'What if you don\'t think we\'re a fit?',
                  a: 'We refund within 7 days, no fight. Fit > revenue. We\'ve walked away from sponsors twice already.',
                },
                {
                  q: 'Can we cancel any time?',
                  a: 'Yes. Stripe handles cancellation directly. Stop showing up in deliverables the next month.',
                },
                {
                  q: 'Will you exclusive a category?',
                  a: 'Co-marketed tier gets soft-exclusivity in their category for the quarter they pay. Featured + Spotlight don\'t — we may run a competing brand in the same space.',
                },
                {
                  q: 'Can we pay annually?',
                  a: 'Yes — email and we\'ll send an invoice for 12× monthly with a 1-month discount baked in.',
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
