// /start — 4-audience self-select landing page, conversion-optimized.
//
// Research-backed elements layered into the audience-grid base:
//   - Geo-personalized headline (read Vercel x-vercel-ip-country-region
//     or ?state= param; state appears in hero + buyer card subtext)
//   - LIVE recent-close badge + 24h activity log (real-time momentum)
//   - Risk-reversal microcopy under every CTA
//   - Time-anchored CTAs ("Talk to a rancher in 24h")
//   - Founder face glyph + name
//   - Inline FAQ (top 3 objections, native <details>)
//   - Mobile sticky CTA when audience grid scrolls out of view
//   - Trust signals strip (USDA + Stripe + verified)
//   - Specific numbers (not rounded — Schindler & Yalch)
//
// Voice: direct relationships + food integrity + freezer-fill abundance.
// NOT price/discount framing. We never say "cheaper than grocery."

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import {
  PageViewTracker,
  AudienceCard,
  StickyMobileCTA,
  InlineFAQ,
} from './StartButtons';
import ExitIntentModal from '@/app/components/ExitIntentModal';
import { getRecentTestimonials, type Testimonial } from '@/lib/testimonials';
import { getActiveRancherPages } from '@/lib/airtable';
import { normalizeImageUrl } from '@/lib/imageUrl';

export const metadata: Metadata = {
  title: 'real beef. real ranchers. direct.',
  description: "pick who you are. we route you in 5 seconds. buyers, ranchers, backers, brands.",
  openGraph: {
    title: 'real beef. real ranchers. direct.',
    description: "pick who you are. we route you in 5 seconds.",
    type: 'website',
    url: 'https://www.buyhalfcow.com/start',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'real beef. real ranchers. direct.',
    description: "pick who you are. we route you in 5 seconds.",
  },
};

// dynamic = the page reads request headers for geo-personalization.
// ISR is incompatible with dynamic header reads; we cache the stat
// fetches via Next.js fetch revalidate instead.
export const dynamic = 'force-dynamic';

interface RecentClose {
  firstName: string;
  orderType: string;
  ranchName: string;
  ranchSlug: string;
  buyerState: string;
  daysAgo: number;
}

interface Activity24h {
  closes: number;
  matched: number;
  signups: number;
}

interface PublicStats {
  ranchersActive: number;
  familiesMatched: number;
  foundersBacked: number;
  foundersCap: number;
  totalClosedWon: number;
  thisMonthClosedWon: number;
  latestClose: RecentClose | null;
  activity24h: Activity24h;
}

// /api/stats/public is ISR-cached 5 min + Cache-Control 5 min, so this
// fetch hits CDN/edge cache on most requests. /start no longer needs to
// re-query Airtable directly — single cached endpoint feeds stats +
// latestClose + activity24h.
async function fetchStats(): Promise<PublicStats> {
  try {
    const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
    const res = await fetch(`${SITE_URL}/api/stats/public`, {
      next: { revalidate: 300 },
    });
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
      latestClose: null,
      activity24h: { closes: 0, matched: 0, signups: 0 },
    };
  }
}

interface RancherPreview {
  id: string;
  slug: string;
  ranchName: string;
  state: string;
  logoUrl: string;
}

async function fetchRancherPreview(): Promise<RancherPreview[]> {
  try {
    const ranchers = (await getActiveRancherPages()) as any[];
    if (ranchers.length === 0) return [];
    const withLogo = ranchers.filter((r: any) => (r['Logo URL'] || '').toString());
    const withoutLogo = ranchers.filter((r: any) => !(r['Logo URL'] || '').toString());
    const shuffle = (arr: any[]) => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    const pool = [...shuffle(withLogo), ...shuffle(withoutLogo)];
    return pool.slice(0, 4).map((r: any) => ({
      id: r.id,
      slug: (r['Slug'] || '').toString(),
      ranchName: (r['Ranch Name'] || '').toString(),
      state: (r['State'] || '').toString(),
      // Normalize sharing URLs (Dropbox, Drive) to raw image bytes —
      // otherwise <img src> renders broken preview HTML
      logoUrl: normalizeImageUrl((r['Logo URL'] || '').toString()),
    }));
  } catch {
    return [];
  }
}

function formatDaysAgo(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

function rancherInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

// ── Geo-personalization ─────────────────────────────────────────────
// Read state from Vercel edge headers OR ?state= query param. Server
// component, so this runs once per request. State name (e.g. "Montana")
// surfaces in hero + buyer card subtext when detected.
const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

async function detectState(searchParams: Record<string, string | undefined>): Promise<string | null> {
  // Query param wins (allows manual sharing of geo-tailored URLs)
  const fromQuery = (searchParams.state || '').toString().toUpperCase().trim();
  if (fromQuery && STATE_NAMES[fromQuery]) return STATE_NAMES[fromQuery];

  // Vercel edge geo header
  try {
    const h = await headers();
    const region = (h.get('x-vercel-ip-country-region') || '').toUpperCase();
    if (region && STATE_NAMES[region]) return STATE_NAMES[region];
  } catch {
    // headers() may not be available in some contexts — fall through
  }

  return null;
}

export default async function StartPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const [stats, testimonials, ranchers, detectedState] = await Promise.all([
    fetchStats(),
    getRecentTestimonials(1),
    fetchRancherPreview(),
    detectState(params),
  ]);
  // Defensive defaults — during deploy cutover, the cached
  // /api/stats/public response may briefly serve an older shape
  // without these fields. Falling through with sane defaults keeps
  // the page from 500-ing on stale cache hits.
  const latestClose = stats.latestClose ?? null;
  const activity = stats.activity24h ?? { closes: 0, matched: 0, signups: 0 };
  const featured: Testimonial | null = testimonials[0] || null;
  const foundersLeft = Math.max(0, stats.foundersCap - stats.foundersBacked);
  const backerCardClaimed = stats.foundersBacked >= stats.foundersCap;
  const has24hActivity = activity.closes > 0 || activity.matched > 0 || activity.signups > 0;

  // FAQ — top 3 objections (Baymard top-objection research)
  // Stat-driven first answer pulls live counts so we never claim more than we have.
  const faqItems = [
    {
      q: 'is this real? who runs this?',
      a: `yes. built by ben (full name on /about + every email signature). ${stats.ranchersActive} verified ranchers, ${stats.familiesMatched.toLocaleString()}+ families in pipeline, ${stats.totalClosedWon} deals closed. each rancher signs a partnership agreement before going live; we verify USDA processor + farm ID. no anonymous shell game.`,
    },
    {
      q: 'how does it actually work?',
      a: '(1) take the buyer quiz — we capture your state, household size, timing. (2) if a rancher serves your state, we route you within hours; if not, you go on the priority waitlist + we recruit. (3) the rancher emails you direct with pricing, processing date, delivery. (4) put down a deposit to reserve your slot — fully refundable until your rancher accepts it (typically 24-48h), non-refundable after. (5) beef in your freezer in 2-4 weeks. no marketplace middleman — you pay the rancher direct, with a transparent service fee shown at checkout. BHC Promise (refundable window + cold-chain guarantee + mediation) on every match.',
    },
    {
      q: "what if there's no rancher in my state yet?",
      a: "you go on the state waitlist + get a monthly note while we scout ranchers in your area. we cold-email d2c ranchers every week to add coverage. in the meantime you can back the founding herd — that capital directly funds the next 100 ranchers we onboard, including yours.",
    },
  ];

  // Headline + buyer-card subline — geo-personalized when state detected
  const heroHeadline = detectedState
    ? `real beef. real ranchers in ${detectedState.toLowerCase()}.`
    : 'real beef. real ranchers. direct.';
  const buyerBody = detectedState
    ? `if a rancher serves ${detectedState}, we route you to them within 24 hours. you talk direct — no marketplace middleman, transparent fee at checkout. if no rancher in ${detectedState} yet, you go on the priority waitlist.`
    : 'if a rancher serves your state, we route you within 24 hours. you talk direct — no marketplace middleman, transparent fee at checkout. if no rancher in your state yet, you go on the priority waitlist.';

  // JSON-LD Schema.org Organization markup — Google rich-result eligibility
  // for BuyHalfCow as a primary entity. Renders via JSON.stringify (XSS-safe).
  const orgJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'BuyHalfCow',
    url: 'https://www.buyhalfcow.com',
    logo: 'https://www.buyhalfcow.com/og-image.png',
    founder: {
      '@type': 'Person',
      name: 'Ben Beauchman',
    },
  };

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd) }}
      />
      <PageViewTracker />
      <div className="mx-auto max-w-4xl px-5 sm:px-6 py-10 sm:py-16">
        {/* HERO */}
        <div className="max-w-2xl mb-6">
          <h1 className="font-serif text-3xl sm:text-5xl text-charcoal lowercase leading-[1.05] mb-3">
            {heroHeadline}
          </h1>
          <p className="text-saddle text-base sm:text-lg">
            pick who you are. we route you in 5 seconds.
          </p>
        </div>

        {/* LIVE RECENT CLOSE + 24H ACTIVITY STRIP */}
        <div className="mb-8 flex flex-wrap items-center gap-3 text-xs sm:text-sm">
          {latestClose && (
            <div className="inline-flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-sage/15 text-sage-dark border border-sage/40 font-semibold uppercase tracking-wider text-[10px]">
                live
              </span>
              <span className="text-saddle">
                {latestClose.firstName} got a {latestClose.orderType.toLowerCase()} from{' '}
                {latestClose.ranchSlug ? (
                  <a
                    href={`/ranchers/${latestClose.ranchSlug}`}
                    className="text-charcoal underline underline-offset-2 hover:text-saddle font-medium"
                  >
                    {latestClose.ranchName}
                  </a>
                ) : (
                  <span className="text-charcoal font-medium">{latestClose.ranchName}</span>
                )}
                {latestClose.buyerState && ` · ${latestClose.buyerState}`}
                {' · '}
                {formatDaysAgo(latestClose.daysAgo)}
              </span>
            </div>
          )}
          {has24hActivity && (
            <span className="text-saddle hidden sm:inline">
              last 24h:
              {activity.signups > 0 && (
                <>
                  {' '}
                  <span className="text-charcoal font-medium">
                    {activity.signups}
                  </span>{' '}
                  signed up
                </>
              )}
              {activity.matched > 0 && (
                <>
                  {activity.signups > 0 ? ' · ' : ' '}
                  <span className="text-charcoal font-medium">
                    {activity.matched}
                  </span>{' '}
                  matched
                </>
              )}
              {activity.closes > 0 && (
                <>
                  {(activity.signups > 0 || activity.matched > 0) ? ' · ' : ' '}
                  <span className="text-charcoal font-medium">
                    {activity.closes}
                  </span>{' '}
                  closed
                </>
              )}
            </span>
          )}
        </div>

        {/* ──────── EXPLAINER VIDEO ──────────────────────────────────────
            Renders YouTube embed when NEXT_PUBLIC_START_VIDEO_ID is set.
            Otherwise hidden — no placeholder copy visible to paid traffic.
            Above-the-fold position: hero + LIVE strip frames the video,
            video frames the audience grid below. Decision happens AFTER
            watching the explainer.
            Format: 16:9 desktop, 16:9 mobile (vs /access which is 9:16
            for ad-landing vertical-first). /start serves all 4 audiences
            so we want desktop-friendly aspect. */}
        {process.env.NEXT_PUBLIC_START_VIDEO_ID && (
          <div className="aspect-video bg-charcoal mb-10 overflow-hidden">
            <iframe
              src={`https://www.youtube.com/embed/${process.env.NEXT_PUBLIC_START_VIDEO_ID}?rel=0&modestbranding=1`}
              title="BuyHalfCow — what we do, why it matters"
              className="w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          </div>
        )}

        {/* ──────── AUDIENCE SELF-SELECT GRID ──────── */}
        <section
          id="audience-grid"
          className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4"
        >
          {/* BUYERS */}
          <AudienceCard
            href="/access"
            label="buyers"
            meta="90-second quiz"
            headline={
              detectedState
                ? `find a rancher in ${detectedState.toLowerCase()}`
                : 'find real beef in your state'
            }
            proofLine1={`${stats.familiesMatched.toLocaleString()} families in pipeline`}
            proofLine2={`${stats.totalClosedWon} deals closed · ${stats.ranchersActive} verified ranchers`}
            body={buyerBody}
            ctaLabel="talk to a rancher in 24h"
            riskReversal="free · no card · no commitment · cancel anytime"
            route="buyer"
            variant="warm"
          />

          {/* RANCHERS */}
          <AudienceCard
            href="/map/add-a-rancher"
            label="ranchers"
            meta="5-minute setup"
            headline="sell direct · keep 90%"
            proofLine1={`${stats.ranchersActive} ranchers in the network`}
            proofLine2="buyers routed to you in your state, weekly"
            body="set your prices, your cuts, your processing dates. we handle the matching, the email, the closing nudge. you raise the cattle + talk to your buyer."
            ctaLabel="buyers in your inbox tomorrow"
            riskReversal="no contract · pay nothing until first sale · cancel anytime"
            route="rancher"
            variant="neutral"
          />

          {/* BACKERS — founding herd */}
          {backerCardClaimed ? (
            <AudienceCard
              href="/wins"
              label="backers · founding herd"
              meta="100 / 100 claimed"
              headline="see what the herd built"
              proofLine1="founding 100 sold out"
              proofLine2="waitlist + quarterly behind-the-scenes drops"
              body="the first 100 backers funded the platform you see today. follow the build, get first access to the next 100 spots."
              ctaLabel="view wins"
              riskReversal="100% to platform build · public expense ledger every quarter"
              route="founder"
              variant="dark"
            />
          ) : (
            <AudienceCard
              href="/founders"
              label="backers · founding herd"
              meta={`${stats.foundersBacked} / ${stats.foundersCap} claimed`}
              headline="back the food revolution"
              proofLine1={`${foundersLeft} of 100 spots left · from $100`}
              proofLine2="$15k locks lifetime founder #1-10 status"
              body="fund the next 100 ranchers we onboard. lifetime founder status, quarterly behind-the-scenes drops, your name on the wall when we hit 1,000 closes."
              ctaLabel={`lock founder #${stats.foundersBacked + 1} today`}
              riskReversal="100% to platform build · public expense ledger every quarter"
              route="founder"
              variant="dark"
            />
          )}

          {/* TODO(wholesale): add a "wholesale" AudienceCard here once
              StartButtons.tsx accepts a 5th `route` variant ('wholesale')
              + the matching trackEvent('start_button_click', { route }).
              Skipped for now to keep this PR scoped to the form itself. */}

          {/* BRANDS */}
          <AudienceCard
            href="/brand-partners"
            label="brands"
            meta="from $99/mo"
            headline="get in front of d2c ranchers"
            proofLine1={`${stats.ranchersActive} ranchers + ${stats.familiesMatched.toLocaleString()} families`}
            proofLine2="$99 spotlight · $499 featured · $1,500 founding"
            body="logo placement on /map + /matched. pinned posts in member feed. access to ranchers + families who already buy direct from the source."
            ctaLabel="go live this week"
            riskReversal="month-to-month · cancel anytime · setup in 24h"
            route="brand"
            variant="deep"
          />
        </section>

        {/* TRUST STRIP — food integrity, not price savings */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-saddle">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-charcoal font-semibold">✓</span>
            usda-inspected processing
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-charcoal font-semibold">✓</span>
            ranchers verified + agreement-signed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-charcoal font-semibold">✓</span>
            stripe secure checkout
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-charcoal font-semibold">✓</span>
            <a href="/promise" className="hover:text-charcoal underline underline-offset-2">bhc promise</a>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-charcoal font-semibold">✓</span>
            direct from rancher · transparent service fee
          </span>
        </div>

        {/* RANCHERS PREVIEW STRIP */}
        {ranchers.length > 0 && (
          <section className="mt-14">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-xs uppercase tracking-wider text-saddle font-semibold">
                verified ranchers · in stock
              </h2>
              <a
                href="/map"
                className="text-xs text-saddle hover:text-charcoal underline underline-offset-2"
              >
                see all {stats.ranchersActive} →
              </a>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {ranchers.map((r) => (
                <a
                  key={r.id}
                  href={`/ranchers/${r.slug}`}
                  className="group block border border-dust hover:border-charcoal hover:bg-bone-warm transition-base p-3"
                >
                  <div className="aspect-square w-full bg-bone-warm border border-dust mb-2 overflow-hidden flex items-center justify-center">
                    {r.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={r.logoUrl}
                        alt={`${r.ranchName} logo`}
                        loading="lazy"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="font-serif text-3xl text-saddle">
                        {rancherInitial(r.ranchName)}
                      </span>
                    )}
                  </div>
                  <div className="font-medium text-xs sm:text-sm text-charcoal leading-tight line-clamp-2">
                    {r.ranchName}
                  </div>
                  <div className="text-[10px] sm:text-xs text-saddle uppercase tracking-wider mt-0.5">
                    {r.state}
                  </div>
                </a>
              ))}
            </div>
          </section>
        )}

        {/* TESTIMONIAL — real quotes only */}
        {featured && (
          <blockquote className="mt-14 max-w-2xl border-l-2 border-charcoal pl-5 text-charcoal italic text-base sm:text-lg">
            &ldquo;{featured.quote}&rdquo;
            <footer className="mt-2 text-sm text-saddle not-italic">
              {featured.ranchSlug ? (
                <a
                  href={`/ranchers/${featured.ranchSlug}`}
                  className="hover:text-charcoal underline underline-offset-2"
                >
                  {featured.rancherName}
                </a>
              ) : (
                featured.rancherName
              )}
              {featured.buyerState ? ` · ${featured.buyerState}` : ''}
            </footer>
          </blockquote>
        )}

        {/* INLINE FAQ — top 3 objections */}
        <InlineFAQ items={faqItems} />

        {/* FOUNDER FACE GLYPH + LINE */}
        <div className="mt-14 max-w-2xl flex items-center gap-3">
          <div className="w-11 h-11 rounded-full bg-charcoal text-bone flex items-center justify-center font-serif text-lg flex-shrink-0">
            B
          </div>
          <p className="text-saddle text-sm">
            built by ben beauchman, 26, from a truck. no ads. no vc. just
            ranchers + families.
          </p>
        </div>

        {/* SHARE LINK */}
        <footer className="mt-8 pt-6 border-t border-dust max-w-2xl">
          <a
            href="/access?ref=share"
            className="group inline-flex items-baseline gap-2 text-sm text-saddle hover:text-charcoal transition-base"
          >
            <span>
              already love us?{' '}
              <span className="text-charcoal underline underline-offset-2">
                share + earn a free half
              </span>
            </span>
            <span
              aria-hidden="true"
              className="text-charcoal transition-transform group-hover:translate-x-1"
            >
              →
            </span>
          </a>
        </footer>
      </div>

      {/* MOBILE STICKY CTA — shows when audience grid scrolls out */}
      <StickyMobileCTA targetSelector="#audience-grid" />

      <ExitIntentModal />
    </main>
  );
}
