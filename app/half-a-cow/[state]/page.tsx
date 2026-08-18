// /half-a-cow/[state] — programmatic state SEO pages (competitive-report
// growth gap #1, 2026-07-14). "half a cow near me / half a cow texas" is a
// keyword set Half a Cow Club owns outright; BHC had zero state landing
// surface for it. One honest, indexable page per state: what a share costs
// (derived from the REAL pricing ladder in lib/pricing.ts), how it works,
// live supply/waitlist counts when Airtable answers, and the quiz CTA.
//
// BUILD SAFETY (the #1 constraint): all 50 pages prerender at build time
// (generateStaticParams + revalidate 3600). generateStaticParams and
// generateMetadata are PURE — no Airtable. Live counts are fetched inside
// the component per-page, wrapped in withTimeout + try/catch; on any
// failure the page renders a graceful no-counts fallback instead of
// killing the Vercel build (the known transient Airtable prerender-timeout
// killer). CRITICAL: a failed fetch yields NULL (unknown), never 0 — a
// zero-claim ("no ranches") rendered from a timeout would be a lie.
//
// HONESTY RULES: never claim supply that doesn't exist. States with no live
// rancher lead with the waitlist angle; counts render only when real.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Container from '../../components/Container';
import Button from '../../components/Button';
import Divider from '../../components/Divider';
import ProofStrip from '../../components/ProofStrip';
import ProductCard from '../../components/ProductCard';
import base, { TABLES, escapeAirtableValue, withTimeout, resolveAirtableTimeoutMs, stateDiscoveryRanchersFormula } from '@/lib/airtable';
import { getMarketProductsCached } from '@/lib/stateMarket';
import { marketStripFor } from '@/lib/marketStands';
import { jsonLdSafe } from '@/lib/jsonLdSafe';
import {
  SEO_STATES,
  stateBySlug,
  typicalShareRanges,
  stateFaqs,
  waitlistLine,
  fmtRange,
  type SeoState,
} from '@/lib/stateSeo';

// Hourly ISR — counts drift slowly (ranchers go live weekly), and SSG keeps
// these fast + build-safe under organic load.
export const revalidate = 3600;
// Only the 50 generated slugs exist; anything else 404s at the router
// without ever touching Airtable.
export const dynamicParams = false;

const BASE_URL = 'https://www.buyhalfcow.com';

interface Props {
  params: Promise<{ state: string }>;
}

export async function generateStaticParams() {
  // PURE — no fetching here, ever (build-killer constraint).
  return SEO_STATES.map((s) => ({ state: s.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { state } = await params;
  const resolved = stateBySlug(state);
  if (!resolved) {
    return { title: 'BuyHalfCow', description: 'Direct ranch beef. No middlemen.' };
  }
  const { name, slug } = resolved;
  const r = typicalShareRanges();
  const url = `${BASE_URL}/half-a-cow/${slug}`;
  const title = `Buy Half a Cow in ${name} — What It Costs & How It Works`;
  const description =
    `Half a cow in ${name}: typical half-beef shares run ${fmtRange(r.half)} all-in (~$8–11/lb hanging weight vs $13–17/lb boxed delivery). ` +
    `90-second quiz, a real local ranch, ${r.depositPercent}% refundable deposit.`;

  return {
    title,
    description,
    // These pages exist to be indexed (unlike /links).
    robots: { index: true, follow: true },
    alternates: { canonical: url },
    openGraph: { title, description, url, images: ['/og-image.png'] },
    twitter: { card: 'summary_large_image', title, description, images: ['/og-image.png'] },
  };
}

// ── Live counts (best-effort, per-page, build-safe) ────────────────────────
// null = unknown (Airtable unreachable / timed out) → render no numbers.
// 0 = a real answered zero → honest waitlist-first copy.
interface StateCounts {
  liveRanchers: number | null;
  waitlistCount: number | null;
}

async function fetchStateCounts(s: SeoState): Promise<StateCounts> {
  const timeoutMs = resolveAirtableTimeoutMs();
  const safeCode = escapeAirtableValue(s.code);
  const safeName = escapeAirtableValue(s.name.toUpperCase());
  // {State} is unnormalized in places (code vs full name) — match both,
  // same pattern as /access/[state].
  const stateMatch = `OR(UPPER({State}) = "${safeCode}", UPPER({State}) = "${safeName}")`;

  let liveRanchers: number | null = null;
  try {
    const records = await withTimeout(
      base(TABLES.RANCHERS)
        .select({
          // Shared discovery-visibility builder (Wave A, 2026-08-17) — the
          // SAME formula /access/[state] sends, and the same criteria
          // lib/stateSupply.countLiveShareRanchesByState mirrors in JS: a
          // SELF-SERVE broker ranch counts as live supply, a token-only
          // represented ranch stays invisible. The three surfaces must never
          // disagree — change the builder, never a local copy.
          filterByFormula: stateDiscoveryRanchersFormula(s.code, s.name),
          fields: ['Slug'],
          maxRecords: 100,
        })
        .all(),
      timeoutMs,
      `half-a-cow ranchers ${s.code}`,
    );
    liveRanchers = records.length;
  } catch (e) {
    // Soft-fail: page renders the no-counts fallback; ISR retries in an hour.
    console.error(`[half-a-cow/${s.slug}] rancher count fetch failed:`, e);
  }

  let waitlistCount: number | null = null;
  try {
    const records = await withTimeout(
      base(TABLES.CONSUMERS)
        .select({ filterByFormula: stateMatch, fields: ['State'], maxRecords: 2000 })
        .all(),
      timeoutMs,
      `half-a-cow consumers ${s.code}`,
    );
    waitlistCount = records.length;
  } catch (e) {
    console.error(`[half-a-cow/${s.slug}] waitlist count fetch failed:`, e);
  }

  return { liveRanchers, waitlistCount };
}

// ── Page ───────────────────────────────────────────────────────────────────

const STEPS: { title: string; body: (name: string) => string }[] = [
  {
    title: 'take the 90-second quiz',
    body: () =>
      `Share size, timing, freezer space. That's it — it's how we match you instead of listing you.`,
  },
  {
    title: 'get matched with a local family ranch',
    body: (name) =>
      `We route you to a real family operation serving ${name} — named, pictured, yours to talk to.`,
  },
  {
    title: 'reserve with a refundable deposit',
    body: () =>
      `A deposit reserves your share. Fully refundable until the rancher accepts — the balance is due at final weight.`,
  },
];

export default async function HalfACowStatePage({ params }: Props) {
  const { state } = await params;
  const resolved = stateBySlug(state);
  if (!resolved) notFound();

  const { name, code, slug } = resolved;
  const { liveRanchers, waitlistCount } = await fetchStateCounts(resolved);
  const r = typicalShareRanges();
  const faqs = stateFaqs(name);

  // "the {State} market" strip (farmers-market cross-wiring 2026-07-15):
  // up to 3 products a buyer in this state can actually get — nationwide
  // products from ranches covering the state + pickup products from ranches
  // homed here. Same build-safety contract as fetchStateCounts: the cached
  // read fails soft to null → the strip degrades honestly (see below),
  // never a throw, never a fabricated market.
  const marketProducts = await getMarketProductsCached();
  const stripProducts =
    marketProducts === null ? [] : marketStripFor(marketProducts, code).slice(0, 3);
  const marketKnown = marketProducts !== null;

  const hasSupply = liveRanchers !== null && liveRanchers > 0;
  const knownNoSupply = liveRanchers === 0;
  const waitlist = waitlistLine(name, waitlistCount);
  const accessHref = `/access?state=${code}`;

  const priceRows = [
    { k: 'whole beef, all-in (animal + processing)', v: fmtRange(r.whole) },
    { k: 'half beef (~55% of a whole)', v: fmtRange(r.half) },
    { k: 'quarter beef (~28% of a whole)', v: fmtRange(r.quarter) },
    { k: 'your price per pound, hanging weight', v: '~$8–11/lb' },
    { k: 'boxed-delivery services, comparable cuts', v: '$13–17/lb' },
    // No percent here (sweep fix 2026-08-13): under Model 1 the buyer's
    // actual card charge at deposit is the deposit PLUS the platform fee on
    // the full price (~2x the bare deposit percent), so a "25%" promise
    // understates the real charge. The deposit page shows the exact total.
    { k: 'deposit to reserve', v: 'refundable until the rancher accepts' },
  ];

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: BASE_URL },
      { '@type': 'ListItem', position: 2, name: 'Half a Cow Near You', item: `${BASE_URL}/half-a-cow` },
      { '@type': 'ListItem', position: 3, name: name, item: `${BASE_URL}/half-a-cow/${slug}` },
    ],
  };

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdSafe(breadcrumbJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdSafe(faqJsonLd) }}
      />

      {/* ── HERO (mobile-first: headline + CTA above the phone fold) ── */}
      <section className="pt-8 pb-12 md:py-24">
        <Container>
          <div className="max-w-3xl mx-auto text-center space-y-5 md:space-y-6">
            <p className="text-xs uppercase tracking-widest text-saddle font-semibold">
              {name} · beef shares direct from the ranch
            </p>
            <h1 className="font-serif text-4xl md:text-6xl leading-tight lowercase">
              buy half a cow in {name}
            </h1>
            <Divider />
            <p className="text-lg md:text-xl max-w-2xl mx-auto leading-snug md:leading-relaxed text-saddle">
              {hasSupply ? (
                <>
                  {liveRanchers} {liveRanchers === 1 ? 'ranch is' : 'ranches are'} live
                  in {name} right now. A 90-second quiz matches you with yours — no
                  marketplace markup, no middleman.
                </>
              ) : knownNoSupply ? (
                <>
                  We&rsquo;re recruiting family ranches in {name} right now.
                  Get on the list and you&rsquo;re matched first — in the order you
                  signed up — the moment one goes live.
                </>
              ) : (
                <>
                  A 90-second quiz matches you with a real family ranch serving{' '}
                  {name} — or puts you first in line while we recruit one. No
                  marketplace markup, no middleman.
                </>
              )}
            </p>
            {waitlist && (
              <p className="text-sm md:text-base text-charcoal font-medium">{waitlist}</p>
            )}
            <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
              <Button href={accessHref} size="lg">
                {hasSupply ? `find my ${name} ranch →` : `join the ${name} list →`}
              </Button>
              <Button href="/map" variant="secondary" size="lg">
                see the ranch map
              </Button>
            </div>
            <p className="text-[13.5px] text-saddle">
              new to buying beef in bulk?{' '}
              <Link href="/guide" className="underline hover:text-charcoal transition-colors">
                read the honest math first →
              </Link>
            </p>
          </div>
        </Container>
      </section>

      {/* ── WHAT IT COSTS ── */}
      <section className="pb-12 md:pb-20">
        <Container>
          <div className="max-w-2xl mx-auto space-y-6">
            <div className="text-center space-y-3">
              <h2 className="font-serif text-3xl md:text-4xl lowercase">
                what half a cow costs in {name}
              </h2>
              {/* Copy truth (sweep fix 2026-08-13): the old "no hidden fees
                  stacked on top at checkout" line was false for the primary
                  money rail (Model 1 adds the platform fee to the buyer's
                  deposit charge, and the deposit page deliberately shows one
                  total, not a split). Say the true thing instead: the exact
                  total is shown before payment. */}
              <p className="text-saddle text-[15.5px] leading-relaxed">
                every ranch sets its own price — these are the typical all-in ranges
                across the network. the deposit page shows your exact total before
                you pay — no surprise add-ons after that.
              </p>
            </div>
            <div className="border border-dust bg-bone-warm">
              {priceRows.map((row) => (
                <div
                  key={row.k}
                  className="flex justify-between gap-4 items-baseline px-5 py-3.5 border-b border-dust last:border-b-0"
                >
                  <span className="text-[14.5px] text-saddle">{row.k}</span>
                  <span className="font-serif text-lg text-charcoal whitespace-nowrap">{row.v}</span>
                </div>
              ))}
            </div>
            <p className="text-[14.5px] leading-relaxed text-saddle">
              <strong className="text-charcoal">the honest part:</strong> roughly
              40&ndash;50% of a half beef arrives as ground and stew meat — a year of
              real dinners, not a box of ribeyes. plan on ~8&ndash;10 cubic feet of
              freezer space for a half.
            </p>
          </div>
        </Container>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section className="pb-12 md:pb-20">
        <Container>
          <div className="max-w-4xl mx-auto space-y-10">
            <div className="text-center space-y-3">
              <h2 className="font-serif text-3xl md:text-4xl lowercase">how it works</h2>
              <Divider />
            </div>
            <div className="grid md:grid-cols-3 gap-8">
              {STEPS.map((step, i) => (
                <div key={step.title} className="text-center space-y-3">
                  <p className="font-serif text-3xl text-muted">{i + 1}</p>
                  <h3 className="font-serif text-xl lowercase">{step.title}</h3>
                  <p className="text-[14.5px] leading-relaxed text-saddle">{step.body(name)}</p>
                </div>
              ))}
            </div>
            <div className="text-center">
              <Button href={accessHref} size="lg">
                start the 90-second quiz →
              </Button>
            </div>
          </div>
        </Container>
      </section>

      {/* ── THE {STATE} MARKET (farmers-market cross-wiring 2026-07-15) ──
          Up to 3 real local products deep-linking to /shop?state={code}
          (the shop's picker honors the param, so the buyer lands with their
          local market already first). HONESTY three-way: products → cards;
          known-zero supply → the waitlist truth; unknown → neutral copy
          with no numbers and no claims. */}
      <section className="pb-12 md:pb-20">
        <Container>
          <div className="max-w-4xl mx-auto space-y-5">
            <div className="text-center space-y-2">
              <h2 className="font-serif text-3xl md:text-4xl lowercase">the {name} market</h2>
              <p className="text-saddle text-[15px]">
                {stripProducts.length > 0
                  ? `from ranches serving ${name} — shipped frozen, or picked up at the ranch.`
                  : marketKnown && knownNoSupply
                    ? `no ranch stand in ${name} yet.`
                    : // "verified" is TRUE here and stays (wording ruling
                      // 2026-08-18): the market strip is marketplace-product
                      // supply only, and lib/marketplaceProducts drops every
                      // represented (broker) ranch's rows wholesale — this
                      // set, unlike the routing pool, really is all verified.
                      `real beef from verified family ranches, shipped to your door.`}
              </p>
            </div>
            {stripProducts.length > 0 ? (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-5 max-w-2xl mx-auto">
                  {stripProducts.map((p) => (
                    <ProductCard key={p.id} p={p} compact />
                  ))}
                </div>
                <p className="text-center text-[13.5px] text-saddle">
                  <Link
                    href={`/shop?state=${code}`}
                    className="underline hover:text-charcoal transition-colors"
                  >
                    walk the full {name} market →
                  </Link>
                </p>
              </>
            ) : marketKnown && knownNoSupply ? (
              <div className="text-center space-y-3">
                <p className="text-[14.5px] text-saddle max-w-[54ch] mx-auto">
                  {waitlist ? `${waitlist} ` : ''}join the list and you&rsquo;re matched first
                  the moment a {name} ranch goes live.
                </p>
                <Button href={accessHref} variant="secondary" size="sm">
                  join the {name} list →
                </Button>
                <p className="text-[13px] text-saddle">
                  meanwhile —{' '}
                  <Link
                    href={`/shop?state=${code}`}
                    className="underline hover:text-charcoal transition-colors"
                  >
                    every stand in the market ships to {name} →
                  </Link>
                </p>
              </div>
            ) : (
              <p className="text-center text-[13.5px] text-saddle">
                <Link
                  href={`/shop?state=${code}`}
                  className="underline hover:text-charcoal transition-colors"
                >
                  browse the market — jerky, boxes &amp; shares, shipped →
                </Link>
              </p>
            )}
          </div>
        </Container>
      </section>

      {/* ── FAQ (same source as the FAQPage JSON-LD above) ── */}
      <section className="pb-12 md:pb-20">
        <Container>
          <div className="max-w-2xl mx-auto space-y-8">
            {/* Social proof above the FAQ — network-wide live Closed Won
                aggregates (honest: these are network numbers, not {name}
                numbers, and the copy claims nothing state-specific). Same
                build-safety contract as fetchStateCounts: fails soft to
                nothing inside the existing space-y-8 rhythm — a prerender
                can never throw and a timeout never renders a zero. */}
            <ProofStrip className="text-center" />
            <h2 className="font-serif text-3xl md:text-4xl lowercase text-center">
              {name} half-beef questions, answered straight
            </h2>
            <div className="space-y-6">
              {faqs.map((f) => (
                <div key={f.q} className="border-b border-dust pb-6 last:border-b-0 space-y-2">
                  <h3 className="font-serif text-xl">{f.q}</h3>
                  <p className="text-[15px] leading-relaxed text-saddle">{f.a}</p>
                </div>
              ))}
            </div>
          </div>
        </Container>
      </section>

      {/* ── BOTTOM CTA + cross-links ── */}
      <section className="pb-16 md:pb-24">
        <Container>
          <div className="max-w-2xl mx-auto text-center space-y-5">
            <Divider />
            <p className="text-saddle text-[15.5px] leading-relaxed pt-4">
              {hasSupply
                ? `skip the grocery aisle. the quiz routes you to a real ${name} ranch — deposit refundable until they accept.`
                : `${name} families who join now get matched first when a ranch goes live. it costs nothing to be in line.`}
            </p>
            <Button href={accessHref} size="lg">
              {hasSupply ? `find my ${name} ranch →` : `join the ${name} list →`}
            </Button>
            <p className="text-[13.5px] text-saddle">
              not ready for a freezer full?{' '}
              <Link href="/shop" className="underline hover:text-charcoal transition-colors">
                start with jerky &amp; boxes, shipped →
              </Link>{' '}
              · or{' '}
              <Link href="/half-a-cow" className="underline hover:text-charcoal transition-colors">
                see every state →
              </Link>
            </p>
          </div>
        </Container>
      </section>
    </main>
  );
}
