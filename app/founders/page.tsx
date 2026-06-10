// /founders — public capital-raise landing page.
//
// Server component. Mirrors `app/ranchers/page.tsx` shell pattern:
//   • `revalidate = 600` (10 min)
//   • Server-side Airtable fetch
// Sections (per spec):
//   1. Hero
//   2. Live counter (Founding 100 progress)
//   3. Problem framing — Tyson / grocery / corporate squeeze
//   4. Tier table — 5 rows with embedded Stripe Payment Link buttons
//   5. <FoundersWall /> server component
//   6. FAQ
//   7. Sticky bottom CTA on mobile
//
// Voice: matches `/access` — direct, lowercase founder-first, no fake scarcity
// (Founding 100 progress is real). No "10,000 families" or "Private Network"
// or "The HERD". Founding Herd is the campaign name and OK.

import type { Metadata } from 'next';
import Link from 'next/link';
import Container from '../components/Container';
import Divider from '../components/Divider';
import { getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';
import {
  FOUNDING_100_CAP,
  TITLE_FOUNDER_CAP,
  STRIPE_PAYMENT_LINK_HERD_MONTHLY,
  STRIPE_PAYMENT_LINK_HERD_ANNUAL,
  STRIPE_PAYMENT_LINK_OUTLAW_MONTHLY,
  STRIPE_PAYMENT_LINK_OUTLAW_ANNUAL,
  STRIPE_PAYMENT_LINK_STEWARD_MONTHLY,
  STRIPE_PAYMENT_LINK_STEWARD_ANNUAL,
  STRIPE_PAYMENT_LINK_TITLE_FOUNDER,
  FOUNDERS_TEST_MODE,
  getFounding100PriceCents,
  getFounding100PriceLabel,
  FOUNDING_100_EARLY_BIRD_END,
} from '@/lib/secrets';
import FoundersWall from './components/FoundersWall';
import FounderCheckoutButton from './components/FounderCheckoutButton';
import {
  FoundersViewTracker,
  TierLinkButton,
} from './components/FoundersAnalytics';
import ExitIntentModal from '@/app/components/ExitIntentModal';

export const metadata: Metadata = {
  title: 'The Founding Herd',
  description:
    'Five tiers, real backing. The Founding Herd is the people who paid in before BuyHalfCow was easy to bet on. 100 numbered spots at $1,000.',
  openGraph: {
    title: 'The Founding Herd · back BuyHalfCow',
    description:
      '100 spots. From $100. $15k locks lifetime founder #1-10 status. The people who paid in before this was easy to bet on.',
    type: 'website',
    url: 'https://www.buyhalfcow.com/founders',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'The Founding Herd — back BuyHalfCow' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'The Founding Herd · back BuyHalfCow',
    description:
      '100 spots. From $100. $15k locks lifetime founder #1-10 status.',
    images: ['/og-image.png'],
  },
};

export const revalidate = 600;

interface PublicStats {
  ranchersActive: number;
  familiesMatched: number;
  foundersBacked: number;
  foundersCap: number;
  totalClosedWon: number;
  thisMonthClosedWon: number;
}

async function fetchPublicStats(): Promise<PublicStats> {
  try {
    const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
    const res = await fetch(`${SITE_URL}/api/stats/public`, { next: { revalidate: 300 } });
    if (!res.ok) throw new Error(`stats fetch returned ${res.status}`);
    return await res.json();
  } catch {
    return {
      ranchersActive: 17,
      familiesMatched: 1533,
      foundersBacked: 0,
      foundersCap: 100,
      totalClosedWon: 11,
      thisMonthClosedWon: 0,
    };
  }
}

async function countFoundersByTier(tier: string): Promise<number> {
  try {
    const rows = await getAllRecords(
      TABLES.CONSUMERS,
      `{Founder Tier} = "${escapeAirtableValue(tier)}"`
    );
    return rows.length;
  } catch {
    return 0;
  }
}

type TierCardProps = {
  label: string;
  tagline: string;
  priceLine: string;
  bullets: string[];
  buttons: Array<
    | { kind: 'link'; href: string; label: string; tier: string }
    | { kind: 'checkout'; tier: 'founding-100' | 'title-founder' | 'test-1'; label: string; disabled?: boolean }
  >;
  remaining?: string;
  emphasis?: boolean;
};

function TierCard(props: TierCardProps) {
  // Emphasis = capped one-time tiers (Founding 100, Title Founder). They get
  // the deep border + warm bg to feel scarcer / heavier than the recurring
  // subscription tiers below them.
  const surfaceClass = props.emphasis
    ? 'bg-bone-warm border-2 border-charcoal'
    : 'bg-bone border border-dust';
  return (
    <article className={`${surfaceClass} p-7 md:p-8 space-y-6 transition-base hover:border-charcoal flex flex-col`}>
      <header className="space-y-2">
        <p className="text-[11px] uppercase tracking-[0.18em] text-saddle font-semibold">
          {props.label}
        </p>
        <p className="font-serif text-3xl text-charcoal leading-tight">
          {props.tagline}
        </p>
        <p className="text-base text-charcoal font-medium">{props.priceLine}</p>
        {props.remaining && (
          <p className="text-xs text-saddle pt-1">{props.remaining}</p>
        )}
      </header>
      <ul className="text-sm text-charcoal/85 space-y-2.5 leading-relaxed flex-1">
        {props.bullets.map((b, i) => (
          <li key={i} className="flex gap-2.5">
            <span aria-hidden className="text-sage shrink-0 mt-0.5">✓</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
      <div className="space-y-2 pt-2">
        {props.buttons.map((btn, i) =>
          btn.kind === 'link' ? (
            btn.href ? (
              <TierLinkButton
                key={i}
                tier={btn.tier}
                href={btn.href}
                label={btn.label}
              />
            ) : (
              // Dead-button state when Stripe link env var unset. Surface
              // a working fallback (email Ben) instead of silent "coming soon".
              // Audit finding 2026-05-20 #22.
              <a
                key={i}
                href="mailto:ben@buyhalfcow.com?subject=Founders%20tier%20interest"
                className="block text-center px-6 py-3.5 text-sm font-medium tracking-wide uppercase bg-charcoal text-bone transition-base hover:bg-divider"
              >
                Email Ben to claim
              </a>
            )
          ) : (
            <FounderCheckoutButton
              key={i}
              tier={btn.tier}
              label={btn.label}
              disabled={btn.disabled}
            />
          )
        )}
      </div>
    </article>
  );
}

export default async function FoundersPage({
  searchParams,
}: {
  searchParams?: Promise<{ success?: string; cancelled?: string; tier?: string; paid?: string }>;
}) {
  // Stripe redirects backers here after checkout with `?success=1` (and
  // `?session_id=...` from Payment Links via the `{CHECKOUT_SESSION_ID}`
  // template) or `?cancelled=1`. Render a confirmation banner so backers
  // know the payment landed instead of staring at an unchanged tier grid.
  const params = (await searchParams) || {};
  const isSuccess = params.success === '1' || !!params.paid;
  const isCancelled = params.cancelled === '1';
  const paidTier = (params.paid || params.tier || '').toString().replace(/-/g, ' ');

  // Live counts for the hero counter + sold-out gating on capped tiers.
  // Also fetch /api/stats/public (ISR 300s) for the scarcity counter above tiers.
  const [founding100Count, titleFounderCount, publicStats] = await Promise.all([
    countFoundersByTier('Founding 100'),
    countFoundersByTier('Title Founder'),
    fetchPublicStats(),
  ]);

  const scarcityBacked = publicStats.foundersBacked;
  const scarcityCap = publicStats.foundersCap || FOUNDING_100_CAP;
  const scarcityRemaining = scarcityCap - scarcityBacked;
  const scarcityPct = Math.round((scarcityBacked / scarcityCap) * 100);

  const founding100PriceLabel = getFounding100PriceLabel();
  const founding100Cents = getFounding100PriceCents();
  const earlyBirdActive = founding100Cents <= 100000;
  const earlyBirdLabel = earlyBirdActive
    ? `${founding100PriceLabel} early bird`
    : `${founding100PriceLabel} (early bird ended)`;

  const earlyBirdSubline =
    FOUNDING_100_EARLY_BIRD_END && earlyBirdActive
      ? `Price flips to $1,500 on ${new Date(
          FOUNDING_100_EARLY_BIRD_END
        ).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        })}.`
      : '';

  const founding100SoldOut = founding100Count >= FOUNDING_100_CAP;
  const titleFounderSoldOut = titleFounderCount >= TITLE_FOUNDER_CAP;

  // JSON-LD Schema.org Product markup — Google rich-result eligibility for
  // the Founding Herd as a backable product. Tier prices reflect current
  // /founders tier rows (one-time + monthly subscriptions). Renders via
  // JSON.stringify (XSS-safe).
  const foundersJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'The Founding Herd',
    description:
      'Five-tier backing program for BuyHalfCow. Numbered placement, lifetime founder status, monthly letter from the road. 100 numbered Founding 100 spots plus 10 Title Founder slots.',
    brand: {
      '@type': 'Brand',
      name: 'BuyHalfCow',
    },
    offers: [
      {
        '@type': 'Offer',
        name: 'Title Founder',
        price: '15000',
        priceCurrency: 'USD',
        availability: titleFounderSoldOut
          ? 'https://schema.org/SoldOut'
          : 'https://schema.org/InStock',
        url: 'https://www.buyhalfcow.com/founders#tiers',
      },
      {
        '@type': 'Offer',
        name: 'Founding 100',
        price: (founding100Cents / 100).toString(),
        priceCurrency: 'USD',
        availability: founding100SoldOut
          ? 'https://schema.org/SoldOut'
          : 'https://schema.org/InStock',
        url: 'https://www.buyhalfcow.com/founders#tiers',
      },
      {
        '@type': 'Offer',
        name: 'Steward (monthly)',
        price: '75',
        priceCurrency: 'USD',
        url: 'https://www.buyhalfcow.com/founders#tiers',
      },
      {
        '@type': 'Offer',
        name: 'Outlaw (monthly)',
        price: '25',
        priceCurrency: 'USD',
        url: 'https://www.buyhalfcow.com/founders#tiers',
      },
      {
        '@type': 'Offer',
        name: 'Herd (monthly)',
        price: '9',
        priceCurrency: 'USD',
        url: 'https://www.buyhalfcow.com/founders#tiers',
      },
    ],
  };

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      {/* Client-island that fires founders_view on mount + founders_backed
          when ?success=1 / ?paid=<tier> redirect-back from Stripe.
          Wired 2026-05-26 (audit F4 — events were declared but never fired). */}
      <FoundersViewTracker />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(foundersJsonLd) }}
      />
      {/* POST-CHECKOUT BANNER — Stripe redirect lands here. Without this, backers
          see no acknowledgment after paying. Welcome email is the next signal
          but takes 30s+ to arrive. */}
      {isSuccess && (
        <div className="bg-sage text-bone py-5 border-b-2 border-sage-dark">
          <Container>
            <div className="max-w-3xl mx-auto text-center space-y-2">
              <p className="font-bold text-base md:text-lg">
                You&rsquo;re in. Welcome to the Founding Herd
                {paidTier ? ` — ${paidTier}` : ''}.
              </p>
              <p className="text-sm text-bone/90 leading-relaxed">
                A welcome email with everything you need is on its way (usually
                within 60 seconds). If it doesn&rsquo;t arrive, email{' '}
                <a href="mailto:ben@buyhalfcow.com" className="underline underline-offset-2 decoration-bone/60 hover:decoration-bone">
                  ben@buyhalfcow.com
                </a>{' '}
                and I&rsquo;ll sort you personally.
              </p>
            </div>
          </Container>
        </div>
      )}
      {isCancelled && (
        <div className="bg-bone-deep text-charcoal py-4 border-b border-saddle/30">
          <Container>
            <p className="max-w-3xl mx-auto text-center text-sm">
              Checkout cancelled — no charge made. Pick a tier below when
              you&rsquo;re ready.
            </p>
          </Container>
        </div>
      )}

      {/* HERO */}
      <section className="py-20 md:py-28">
        <Container>
          <div className="max-w-3xl mx-auto text-center space-y-5">
            <p className="text-xs uppercase tracking-[0.2em] text-saddle">
              The Founding Herd
            </p>
            <h1 className="font-serif text-4xl md:text-6xl leading-tight">
              100 spots. {founding100PriceLabel} early bird.
            </h1>
            <Divider />
            <p className="text-lg md:text-xl text-charcoal/85 leading-relaxed">
              I'm raising capital from the people who already believe in this
              and want a stake. Five tiers, no equity, no fundraising
              theatrics. The wall lists every backer in real time. Names are
              the proof.
            </p>
            {/* Sales-floor pivot 2026-06-09: backers see the platform, not
                just the brand. Modern sales infrastructure for DTC ranchers
                — Stripe Connect, Cal-driven sales floor, NRD-protected
                deposits. Real metrics over vision. */}
            <p className="text-sm md:text-base text-charcoal/75 leading-relaxed border-t border-dust pt-5">
              <strong>What we built:</strong> Modern sales infrastructure for
              DTC ranchers. Buyer acquisition, qualification quiz, Stripe
              Connect direct charges, NRD-protected deposits, fulfillment
              dashboard — handled. Ranchers raise the cattle. We do everything
              else.
            </p>
            <p className="text-base text-saddle">
              <strong>{founding100Count}</strong> of {FOUNDING_100_CAP} Founding
              100 spots claimed
              {titleFounderCount > 0 ? (
                <>
                  {' · '}
                  <strong>{titleFounderCount}</strong> of {TITLE_FOUNDER_CAP}{' '}
                  Title Founders
                </>
              ) : null}
              .
            </p>
            <div className="pt-4 flex flex-wrap gap-3 justify-center">
              <a
                href="#tiers"
                className="px-8 py-3 bg-charcoal text-bone text-sm tracking-wide hover:bg-divider transition-colors"
              >
                See the tiers
              </a>
              <a
                href="#wall"
                className="px-8 py-3 border border-charcoal text-charcoal text-sm tracking-wide hover:bg-charcoal hover:text-bone transition-colors"
              >
                Read the wall
              </a>
            </div>
            {earlyBirdSubline && (
              <p className="text-xs text-dust">{earlyBirdSubline}</p>
            )}
          </div>
        </Container>
      </section>

      {/* PROBLEM */}
      <section className="py-16 bg-white border-y border-dust">
        <Container>
          <div className="max-w-3xl mx-auto space-y-6">
            <p className="text-xs uppercase tracking-widest text-saddle">
              Why I'm doing this
            </p>
            <h2 className="font-serif text-3xl md:text-4xl leading-snug">
              Four companies own American beef. The ranchers raising it can't
              make rent.
            </h2>
            <div className="space-y-4 text-charcoal/85 leading-relaxed">
              <p>
                Tyson, Cargill, JBS, National Beef. They process roughly 80% of
                the beef in this country. They set the price the rancher
                receives. They set the price the family pays at the grocery
                store. Both numbers move in the wrong direction at the same
                time.
              </p>
              <p>
                I'm building a different lane. A buyer in Texas calls a Texas
                rancher. The rancher knows their name. There's no middleman
                taking a 60% cut. The freezer fills. The ranch stays in the
                family.
              </p>
              <p>
                I've been doing this with about 1,200 buyers and 16 states of
                rancher coverage already. The pipeline works. What it needs is
                fuel — capital to keep onboarding ranchers, capital to ship
                merch and patches and the small physical things that make a
                community real, capital to keep me on the road.
              </p>
              <p className="italic font-serif border-l-2 border-charcoal pl-4 text-charcoal">
                We're gonna take back American ranching and agriculture. One
                family, one rancher, one freezer at a time.
              </p>
              <p>
                The Founding Herd is the people who paid in before this was
                easy to bet on. Below is what each tier gets, what it costs,
                and what's been claimed. — Ben
              </p>
            </div>
          </div>
        </Container>
      </section>

      {/* SCARCITY COUNTER — CRO Phase 1.
          Pulls from /api/stats/public (ISR 300s). Visible loss-aversion signal
          above the tier grid. Copy intensifies as cap fills (<30 remaining). */}
      <section className="py-10 bg-bone-deep border-y border-dust/60">
        <Container>
          <div className="max-w-3xl mx-auto bg-bone border border-charcoal p-6 sm:p-8">
            <div className="flex items-baseline justify-between mb-3">
              <div>
                <div className="font-serif text-3xl sm:text-4xl text-charcoal">
                  {scarcityBacked}{' '}
                  <span className="text-saddle text-xl sm:text-2xl">
                    of {scarcityCap}
                  </span>
                </div>
                <div className="text-sm text-saddle mt-1">
                  founders claimed
                </div>
              </div>
              <div className="text-right">
                <div className="font-serif text-2xl sm:text-3xl text-charcoal">
                  {scarcityRemaining}
                </div>
                <div className="text-sm text-saddle mt-1">
                  spots remaining
                </div>
              </div>
            </div>
            <div className="w-full bg-dust/30 h-3 mt-4 overflow-hidden">
              <div
                className="h-full bg-charcoal transition-all duration-500"
                style={{ width: `${Math.max(2, scarcityPct)}%` }}
              />
            </div>
            <p className="text-xs text-saddle mt-3">
              {scarcityRemaining < 30
                ? `${scarcityRemaining} numbered spots left. founding herd closes at ${scarcityCap}.`
                : `numbered patches ship at claim. ledger sent quarterly. real receipts.`}
            </p>
          </div>
        </Container>
      </section>

      {/* TIERS */}
      <section id="tiers" className="py-20">
        <Container>
          <div className="max-w-5xl mx-auto space-y-10">
            <div className="text-center space-y-2">
              <p className="text-xs uppercase tracking-widest text-saddle">
                Tiers
              </p>
              <h2 className="font-serif text-3xl md:text-4xl">
                Pick the level that fits.
              </h2>
              <p className="text-saddle max-w-2xl mx-auto">
                Three subscriptions, two one-times. Every tier comes with the
                monthly founder letter and a name on the public Founders Wall.
                The higher you go, the more access you get to the build itself.
              </p>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
              {/* Title Founder */}
              <TierCard
                label="Title Founder · 10 spots"
                tagline="Title Founder"
                priceLine="$15,000 one-time"
                remaining={`${titleFounderCount} of ${TITLE_FOUNDER_CAP} claimed`}
                emphasis
                bullets={[
                  'Top of the Founders Wall — name + logo treatment',
                  'Co-build access — looped in on next-rancher / next-state calls before public',
                  'Lifetime everything — every tier benefit forever',
                  'Direct line to me, calendar bypass anytime',
                ]}
                buttons={[
                  STRIPE_PAYMENT_LINK_TITLE_FOUNDER && !titleFounderSoldOut
                    ? {
                        kind: 'link',
                        tier: 'title-founder',
                        href: STRIPE_PAYMENT_LINK_TITLE_FOUNDER,
                        label: 'Claim a Title Founder spot',
                      }
                    : {
                        kind: 'link',
                        tier: 'title-founder',
                        href: '',
                        label: titleFounderSoldOut ? 'Sold out' : 'Claim a Title Founder spot',
                      },
                ]}
              />

              {/* Founding 100 — uses the cap-enforced /api/founders/checkout */}
              <TierCard
                label={`Founding 100 · ${FOUNDING_100_CAP} spots`}
                tagline="Founding 100"
                priceLine={earlyBirdLabel}
                remaining={`${founding100Count} of ${FOUNDING_100_CAP} claimed`}
                emphasis
                bullets={[
                  'Numbered placement on the Founders Wall',
                  'Lifetime priority routing on every rancher in your state',
                  'First-print BuyHalfCow patch with your number on it',
                  '30-min call with me when you want to use it',
                ]}
                buttons={[
                  {
                    kind: 'checkout',
                    tier: 'founding-100',
                    label: founding100SoldOut
                      ? 'Sold out'
                      : `Claim a Founding 100 spot · ${founding100PriceLabel}`,
                    disabled: founding100SoldOut,
                  },
                ]}
              />

              {/* Steward */}
              <TierCard
                label="Steward · subscription"
                tagline="Steward"
                priceLine="$75 / mo or $750 / yr"
                bullets={[
                  'Outlaw + Herd benefits',
                  'Quarterly office-hours video call (small group)',
                  'Public placement on the Founders Wall',
                  'Direct email line to me — flag a rancher to add or a state to prioritize',
                ]}
                buttons={[
                  {
                    kind: 'link',
                    tier: 'steward-monthly',
                    href: STRIPE_PAYMENT_LINK_STEWARD_MONTHLY,
                    label: 'Steward · $75 / month',
                  },
                  {
                    kind: 'link',
                    tier: 'steward-annual',
                    href: STRIPE_PAYMENT_LINK_STEWARD_ANNUAL,
                    label: 'Steward · $750 / year',
                  },
                ]}
              />

              {/* Outlaw */}
              <TierCard
                label="Outlaw · subscription"
                tagline="Outlaw"
                priceLine="$25 / mo or $250 / yr"
                bullets={[
                  'Herd benefits',
                  'Name on the Founders Wall',
                  'Quarterly behind-the-scenes drops',
                  'First dibs on limited rancher batches',
                ]}
                buttons={[
                  {
                    kind: 'link',
                    tier: 'outlaw-monthly',
                    href: STRIPE_PAYMENT_LINK_OUTLAW_MONTHLY,
                    label: 'Outlaw · $25 / month',
                  },
                  {
                    kind: 'link',
                    tier: 'outlaw-annual',
                    href: STRIPE_PAYMENT_LINK_OUTLAW_ANNUAL,
                    label: 'Outlaw · $250 / year',
                  },
                ]}
              />

              {/* Herd */}
              <TierCard
                label="Herd · subscription"
                tagline="Herd"
                priceLine="$9 / mo or $90 / yr"
                bullets={[
                  'Monthly founder letter from the road',
                  'Early heads-up when a rancher goes live in your state',
                  'First-print BuyHalfCow patch (mailed once)',
                  'Quiet backing — your name stays private unless you opt in',
                ]}
                buttons={[
                  {
                    kind: 'link',
                    tier: 'herd-monthly',
                    href: STRIPE_PAYMENT_LINK_HERD_MONTHLY,
                    label: 'Herd · $9 / month',
                  },
                  {
                    kind: 'link',
                    tier: 'herd-annual',
                    href: STRIPE_PAYMENT_LINK_HERD_ANNUAL,
                    label: 'Herd · $90 / year',
                  },
                ]}
              />

              {/* $1 verification — only when FOUNDERS_TEST_MODE=true */}
              {FOUNDERS_TEST_MODE && (
                <TierCard
                  label="$1 verification (test mode)"
                  tagline="Verification"
                  priceLine="$1 one-time"
                  bullets={[
                    'Internal end-to-end webhook verification',
                    'Refund via Stripe dashboard after the smoke test',
                  ]}
                  buttons={[
                    {
                      kind: 'checkout',
                      tier: 'test-1',
                      label: '$1 verification charge',
                    },
                  ]}
                />
              )}
            </div>
          </div>
        </Container>
      </section>

      {/* WALL */}
      <section id="wall" className="py-16 bg-white border-t border-dust">
        <Container>
          <div className="max-w-5xl mx-auto">
            <FoundersWall />
          </div>
        </Container>
      </section>

      {/* FAQ */}
      <section className="py-20">
        <Container>
          <div className="max-w-3xl mx-auto space-y-8">
            <div className="text-center space-y-2">
              <p className="text-xs uppercase tracking-widest text-saddle">
                Common questions
              </p>
              <h2 className="font-serif text-3xl md:text-4xl">
                FAQ
              </h2>
            </div>

            <div className="space-y-6">
              {[
                {
                  q: 'Is this equity?',
                  a: "No. It's a backing program — you're paying in to support the build. There's no equity, no SAFE, no securities promise. You get the perks listed under each tier; that's it.",
                },
                {
                  q: 'What does the money go to?',
                  a: 'Onboarding ranchers (the biggest cost), shipping merch and patches, my time on the road. I send a quarterly expense breakdown to all backers. Steward+ gets a quarterly group call to ask anything about the spend.',
                },
                {
                  q: 'Can I be a Founder and a Buyer?',
                  a: 'Yes. The two are completely separate. Founders are people backing the build; Buyers are people buying beef. Many backers will be both. We never confuse the two states in our system.',
                },
                {
                  q: 'What happens if I cancel my subscription?',
                  a: "You stop getting the perks the day the subscription ends. No clawback on what you've already paid. Wall placement stays for the months you backed.",
                },
                {
                  q: 'Why only 100 Founding 100 spots?',
                  a: "Because once it's claimed, it's claimed. The number on the patch is real. After 100, the price flips to $1,500 and there's no more numbered placement at the early-bird price.",
                },
                {
                  q: 'How does the Wall work?',
                  a: 'Title Founders and Founding 100 are listed by default — that placement is part of what you bought. Stewards and Outlaws can opt in or out. Herd-tier backers are private by default; they can opt in by replying to the welcome email.',
                },
                {
                  q: 'Is my email going on a list?',
                  a: "Only the Founding Herd list — monthly letter from the road. You can reply directly; it lands with me. We don't sell, share, or run paid ads off this list.",
                },
              ].map((faq, i) => (
                <div key={i} className="border-b border-bone-deep pb-5">
                  <p className="font-serif text-lg mb-2">
                    {faq.q}
                  </p>
                  <p className="text-charcoal/85 leading-relaxed">{faq.a}</p>
                </div>
              ))}
            </div>

            <div className="text-center pt-4">
              <p className="text-sm text-saddle">
                Got a different question? Email me directly:{' '}
                <Link
                  href="mailto:ben@buyhalfcow.com"
                  className="underline hover:text-charcoal"
                >
                  ben@buyhalfcow.com
                </Link>
              </p>
            </div>
          </div>
        </Container>
      </section>

      {/* CROSS-PAGE FOOTER — sites that funnel campaign traffic into /founders
          need an exit ramp to the rest of the network so backers don't dead-end. */}
      <section className="py-12 border-t border-dust/40">
        <Container>
          <div className="max-w-3xl mx-auto text-center space-y-4">
            <p className="text-xs uppercase tracking-widest text-saddle">
              The rest of the network
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <Link
                href="/map"
                className="text-sm px-5 py-2 border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
              >
                Discover map
              </Link>
              <Link
                href="/map/add-a-rancher"
                className="text-sm px-5 py-2 border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
              >
                Add a rancher
              </Link>
              <Link
                href="/access"
                className="text-sm px-5 py-2 border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
              >
                Buyer access
              </Link>
              <Link
                href="/partner"
                className="text-sm px-5 py-2 border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
              >
                Rancher partner
              </Link>
              <Link
                href="/faq"
                className="text-sm px-5 py-2 border border-charcoal hover:bg-charcoal hover:text-bone transition-colors"
              >
                FAQ
              </Link>
            </div>
            <p className="text-xs text-dust pt-4">
              <Link href="/terms" className="underline hover:text-charcoal">Terms</Link>
              {' · '}
              <Link href="/privacy" className="underline hover:text-charcoal">Privacy</Link>
              {' · '}
              BuyHalfCow · Kalispell, MT
            </p>
          </div>
        </Container>
      </section>

      {/* STICKY MOBILE CTA */}
      <div className="md:hidden fixed bottom-0 inset-x-0 bg-charcoal text-bone z-40 border-t border-saddle">
        <a
          href="#tiers"
          className="block text-center py-4 text-sm tracking-widest"
        >
          Pick a tier · {founding100Count}/{FOUNDING_100_CAP} claimed
        </a>
      </div>

      {/* Spacer so the sticky CTA doesn't cover footer content on mobile */}
      <div className="md:hidden h-14" aria-hidden="true" />
      <ExitIntentModal />
    </main>
  );
}
