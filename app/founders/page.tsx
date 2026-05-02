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

export const metadata: Metadata = {
  title: 'The Founding Herd — back BuyHalfCow',
  description:
    'Five tiers, real backing. The Founding Herd is the people who paid in before BuyHalfCow was easy to bet on. 100 numbered spots at $1,000.',
};

export const revalidate = 600;

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
    | { kind: 'link'; href: string; label: string }
    | { kind: 'checkout'; tier: 'founding-100' | 'title-founder' | 'test-1'; label: string; disabled?: boolean }
  >;
  remaining?: string;
  emphasis?: boolean;
};

function TierCard(props: TierCardProps) {
  return (
    <div
      className={`border ${
        props.emphasis ? 'border-[#0E0E0E]' : 'border-[#A7A29A]'
      } bg-white p-6 md:p-8 space-y-5`}
    >
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-widest text-[#6B4F3F]">
          {props.label}
        </p>
        <p className="font-[family-name:var(--font-playfair)] text-2xl">
          {props.tagline}
        </p>
        <p className="text-lg text-[#0E0E0E]">{props.priceLine}</p>
        {props.remaining && (
          <p className="text-xs text-[#6B4F3F]">{props.remaining}</p>
        )}
      </div>
      <ul className="text-sm text-[#2A2A2A] space-y-2 leading-relaxed">
        {props.bullets.map((b, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-[#6B4F3F]">·</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
      <div className="space-y-2">
        {props.buttons.map((btn, i) =>
          btn.kind === 'link' ? (
            btn.href ? (
              <a
                key={i}
                href={btn.href}
                className="block text-center px-6 py-3 text-sm tracking-wide bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#6B4F3F]"
              >
                {btn.label}
              </a>
            ) : (
              <span
                key={i}
                className="block text-center px-6 py-3 text-sm tracking-wide bg-[#A7A29A] text-[#F4F1EC] cursor-not-allowed"
                aria-disabled
              >
                {btn.label} (coming soon)
              </span>
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
    </div>
  );
}

export default async function FoundersPage() {
  // Live counts for the hero counter + sold-out gating on capped tiers.
  const [founding100Count, titleFounderCount] = await Promise.all([
    countFoundersByTier('Founding 100'),
    countFoundersByTier('Title Founder'),
  ]);

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

  return (
    <main className="min-h-screen bg-[#F4F1EC] text-[#0E0E0E]">
      {/* HERO */}
      <section className="py-20 md:py-28">
        <Container>
          <div className="max-w-3xl mx-auto text-center space-y-5">
            <p className="text-xs uppercase tracking-[0.2em] text-[#6B4F3F]">
              The Founding Herd
            </p>
            <h1 className="font-[family-name:var(--font-playfair)] text-4xl md:text-6xl leading-tight">
              100 spots. {founding100PriceLabel} early bird.
            </h1>
            <Divider />
            <p className="text-lg md:text-xl text-[#2A2A2A] leading-relaxed">
              I'm raising capital from the people who already believe in this
              and want a stake. Five tiers, no equity, no fundraising
              theatrics. The wall lists every backer in real time. Names are
              the proof.
            </p>
            <p className="text-base text-[#6B4F3F]">
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
                className="px-8 py-3 bg-[#0E0E0E] text-[#F4F1EC] text-sm tracking-wide hover:bg-[#6B4F3F] transition-colors"
              >
                See the tiers
              </a>
              <a
                href="#wall"
                className="px-8 py-3 border border-[#0E0E0E] text-[#0E0E0E] text-sm tracking-wide hover:bg-[#0E0E0E] hover:text-[#F4F1EC] transition-colors"
              >
                Read the wall
              </a>
            </div>
            {earlyBirdSubline && (
              <p className="text-xs text-[#A7A29A]">{earlyBirdSubline}</p>
            )}
          </div>
        </Container>
      </section>

      {/* PROBLEM */}
      <section className="py-16 bg-white border-y border-[#A7A29A]">
        <Container>
          <div className="max-w-3xl mx-auto space-y-6">
            <p className="text-xs uppercase tracking-widest text-[#6B4F3F]">
              Why I'm doing this
            </p>
            <h2 className="font-[family-name:var(--font-playfair)] text-3xl md:text-4xl leading-snug">
              Four companies own American beef. The ranchers raising it can't
              make rent.
            </h2>
            <div className="space-y-4 text-[#2A2A2A] leading-relaxed">
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
              <p className="italic font-[family-name:var(--font-playfair)] border-l-2 border-[#0E0E0E] pl-4 text-[#0E0E0E]">
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

      {/* TIERS */}
      <section id="tiers" className="py-20">
        <Container>
          <div className="max-w-5xl mx-auto space-y-10">
            <div className="text-center space-y-2">
              <p className="text-xs uppercase tracking-widest text-[#6B4F3F]">
                Tiers
              </p>
              <h2 className="font-[family-name:var(--font-playfair)] text-3xl md:text-4xl">
                Pick the level that fits.
              </h2>
              <p className="text-[#6B4F3F] max-w-2xl mx-auto">
                Three subscriptions, two one-times. Every tier comes with the
                Founding Herd Telegram and the monthly road letter. The higher
                you go, the more access you get to the build itself.
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
                        href: STRIPE_PAYMENT_LINK_TITLE_FOUNDER,
                        label: 'Claim a Title Founder spot',
                      }
                    : {
                        kind: 'link',
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
                  'Quarterly office-hours calls (small group)',
                  'Founders Wall placement',
                  'Direct Telegram access — flag a rancher to add or a state to prioritize',
                ]}
                buttons={[
                  {
                    kind: 'link',
                    href: STRIPE_PAYMENT_LINK_STEWARD_MONTHLY,
                    label: 'Steward · $75 / month',
                  },
                  {
                    kind: 'link',
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
                    href: STRIPE_PAYMENT_LINK_OUTLAW_MONTHLY,
                    label: 'Outlaw · $25 / month',
                  },
                  {
                    kind: 'link',
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
                  'Standing invite to the Founding Herd Telegram',
                  'Quiet backing — your name stays private unless you opt in',
                ]}
                buttons={[
                  {
                    kind: 'link',
                    href: STRIPE_PAYMENT_LINK_HERD_MONTHLY,
                    label: 'Herd · $9 / month',
                  },
                  {
                    kind: 'link',
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
      <section id="wall" className="py-16 bg-white border-t border-[#A7A29A]">
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
              <p className="text-xs uppercase tracking-widest text-[#6B4F3F]">
                Common questions
              </p>
              <h2 className="font-[family-name:var(--font-playfair)] text-3xl md:text-4xl">
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
                  a: 'Onboarding ranchers (the biggest cost), shipping merch and patches, my time on the road. I keep a public expense ledger in the Founding Herd Telegram. Steward+ gets a quarterly call to ask anything about the spend.',
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
                <div key={i} className="border-b border-[#E5E2DC] pb-5">
                  <p className="font-[family-name:var(--font-playfair)] text-lg mb-2">
                    {faq.q}
                  </p>
                  <p className="text-[#2A2A2A] leading-relaxed">{faq.a}</p>
                </div>
              ))}
            </div>

            <div className="text-center pt-4">
              <p className="text-sm text-[#6B4F3F]">
                Got a different question? Email me directly:{' '}
                <Link
                  href="mailto:ben@buyhalfcow.com"
                  className="underline hover:text-[#0E0E0E]"
                >
                  ben@buyhalfcow.com
                </Link>
              </p>
            </div>
          </div>
        </Container>
      </section>

      {/* STICKY MOBILE CTA */}
      <div className="md:hidden fixed bottom-0 inset-x-0 bg-[#0E0E0E] text-[#F4F1EC] z-40 border-t border-[#6B4F3F]">
        <a
          href="#tiers"
          className="block text-center py-4 text-sm tracking-widest"
        >
          Pick a tier · {founding100Count}/{FOUNDING_100_CAP} claimed
        </a>
      </div>

      {/* Spacer so the sticky CTA doesn't cover footer content on mobile */}
      <div className="md:hidden h-14" aria-hidden="true" />
    </main>
  );
}
