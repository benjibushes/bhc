// /start — conversion-optimized bio router.
//
// Layout:
//   1. Hero (tight serif headline + subhead)
//   2. Live recent-close badge (real transaction in last N days)
//   3. PRIMARY CTA — buyer "get matched" (full-width charcoal slab)
//   4. Trust line below CTA — "free · no card · routed in your state"
//   5. Big stats (3 large serif numbers, no boxes)
//   6. Featured ranchers (3-up card grid w/ logos, prices, state) → /ranchers/[slug]
//   7. Founders Herd card (distinct, scarcity bar + claim CTA)
//   8. Brand Partner card (distinct, tier prices + CTA)
//   9. Real testimonial (only if explicit Testimonial field set)
//  10. Footer (rancher join text-link + share-earn text-link)

import type { Metadata } from 'next';
import PrimaryBuyerCTA, { FounderCard, BrandCard } from './StartButtons';
import ExitIntentModal from '@/app/components/ExitIntentModal';
import { getRecentTestimonials, type Testimonial } from '@/lib/testimonials';
import {
  getAllRecords,
  getActiveRancherPages,
  getRecordById,
  TABLES,
} from '@/lib/airtable';

export const metadata: Metadata = {
  title: 'buyhalfcow — real beef. real ranchers. direct.',
  description: "pick your state. talk to the rancher direct.",
  openGraph: {
    title: 'buyhalfcow — real beef. real ranchers. direct.',
    description: "pick your state. talk to the rancher direct.",
    type: 'website',
  },
};

export const revalidate = 300;

interface PublicStats {
  ranchersActive: number;
  familiesMatched: number;
  foundersBacked: number;
  foundersCap: number;
  totalClosedWon: number;
  thisMonthClosedWon: number;
}

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
    };
  }
}

interface RecentClose {
  firstName: string;
  orderType: string;
  ranchName: string;
  ranchSlug: string;
  buyerState: string;
  daysAgo: number;
}

async function fetchLatestClose(): Promise<RecentClose | null> {
  try {
    const refs = (await getAllRecords(
      TABLES.REFERRALS,
      `AND({Status} = "Closed Won", {Sale Amount} > 0)`,
    )) as any[];
    if (refs.length === 0) return null;
    refs.sort((a, b) => {
      const aT = new Date((a['Closed At'] || '').toString()).getTime() || 0;
      const bT = new Date((b['Closed At'] || '').toString()).getTime() || 0;
      return bT - aT;
    });
    const ref = refs[0];
    const buyerName = (ref['Buyer Name'] || '').toString();
    const firstName = buyerName.trim().split(/\s+/)[0] || 'a buyer';
    const orderType = (ref['Order Type'] || 'Beef').toString();
    const buyerState = (ref['Buyer State'] || '').toString();
    const closedAt = (ref['Closed At'] || '').toString();
    const daysAgo = closedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(closedAt).getTime()) / 86_400_000))
      : 0;
    let ranchName = 'a verified rancher';
    let ranchSlug = '';
    const rancherIds: string[] = (ref['Rancher'] || []) as string[];
    if (rancherIds[0]) {
      try {
        const rancher: any = await getRecordById(TABLES.RANCHERS, rancherIds[0]);
        ranchName = (rancher['Ranch Name'] || rancher['Operator Name'] || ranchName).toString();
        ranchSlug = (rancher['Slug'] || '').toString();
      } catch {
        // missing rancher — fall through
      }
    }
    return { firstName, orderType, ranchName, ranchSlug, buyerState, daysAgo };
  } catch {
    return null;
  }
}

interface RancherPreview {
  id: string;
  slug: string;
  ranchName: string;
  state: string;
  beefTypes: string;
  logoUrl: string;
  startingPrice: number | null;
}

async function fetchRancherPreview(): Promise<RancherPreview[]> {
  try {
    const ranchers = (await getActiveRancherPages()) as any[];
    if (ranchers.length === 0) return [];
    // Prefer ranchers WITH logos so the card grid looks intentional.
    // Fall through to no-logo ranchers if fewer than 3 logos exist.
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
    return pool.slice(0, 3).map((r: any) => {
      const prices = [
        Number(r['Quarter Price']) || null,
        Number(r['Half Price']) || null,
        Number(r['Whole Price']) || null,
      ].filter((p): p is number => p !== null && p > 0);
      const startingPrice = prices.length > 0 ? Math.min(...prices) : null;
      return {
        id: r.id,
        slug: (r['Slug'] || '').toString(),
        ranchName: (r['Ranch Name'] || '').toString(),
        state: (r['State'] || '').toString(),
        beefTypes: (r['Beef Types'] || '').toString(),
        logoUrl: (r['Logo URL'] || '').toString(),
        startingPrice,
      };
    });
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

export default async function StartPage() {
  const [stats, testimonials, latestClose, ranchers] = await Promise.all([
    fetchStats(),
    getRecentTestimonials(1),
    fetchLatestClose(),
    fetchRancherPreview(),
  ]);
  const featured: Testimonial | null = testimonials[0] || null;

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="mx-auto max-w-2xl px-5 sm:px-6 py-10 sm:py-16">
        {/* HERO */}
        <h1 className="font-serif text-4xl sm:text-5xl text-charcoal lowercase leading-[1.05] mb-3">
          real beef.<br />
          real ranchers. direct.
        </h1>
        <p className="text-saddle text-base sm:text-lg mb-6">
          pick your state. talk to the rancher direct.
        </p>

        {/* LIVE RECENT CLOSE BADGE */}
        {latestClose && (
          <div className="mb-6 inline-flex items-center gap-2 text-xs sm:text-sm">
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

        {/* PRIMARY CTA + TRUST LINE */}
        <PrimaryBuyerCTA />
        <p className="mt-3 text-xs sm:text-sm text-saddle">
          free · no card · routed in your state · you talk direct
        </p>

        {/* BIG STATS — visual punch, no boxes */}
        <div className="mt-10 grid grid-cols-3 gap-4">
          <div>
            <div className="font-serif text-3xl sm:text-5xl text-charcoal leading-none">
              {stats.ranchersActive}
            </div>
            <div className="text-[10px] sm:text-xs uppercase tracking-wider text-saddle mt-2">
              verified ranchers
            </div>
          </div>
          <div>
            <div className="font-serif text-3xl sm:text-5xl text-charcoal leading-none">
              {stats.familiesMatched.toLocaleString()}
            </div>
            <div className="text-[10px] sm:text-xs uppercase tracking-wider text-saddle mt-2">
              families
            </div>
          </div>
          <div>
            <div className="font-serif text-3xl sm:text-5xl text-charcoal leading-none">
              {stats.totalClosedWon}
            </div>
            <div className="text-[10px] sm:text-xs uppercase tracking-wider text-saddle mt-2">
              deals closed
            </div>
          </div>
        </div>

        {/* FEATURED RANCHERS — logo grid, real visual punch */}
        {ranchers.length > 0 && (
          <section className="mt-12">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-xs uppercase tracking-wider text-saddle font-semibold">
                ranchers in stock
              </h2>
              <a
                href="/map"
                className="text-xs text-saddle hover:text-charcoal underline underline-offset-2"
              >
                see all {stats.ranchersActive} →
              </a>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {ranchers.map((r) => (
                <a
                  key={r.id}
                  href={`/ranchers/${r.slug}`}
                  className="group block border border-dust hover:border-charcoal hover:bg-bone-warm transition-base p-3 sm:p-4"
                >
                  {/* Logo or initial fallback */}
                  <div className="aspect-square w-full bg-bone-warm border border-dust mb-3 overflow-hidden flex items-center justify-center">
                    {r.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={r.logoUrl}
                        alt={`${r.ranchName} logo`}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="font-serif text-3xl text-saddle">
                        {rancherInitial(r.ranchName)}
                      </span>
                    )}
                  </div>
                  <div className="font-medium text-xs sm:text-sm text-charcoal leading-tight mb-1 line-clamp-2">
                    {r.ranchName}
                  </div>
                  <div className="text-[10px] sm:text-xs text-saddle uppercase tracking-wider">
                    {r.state}
                    {r.startingPrice && ` · from $${r.startingPrice.toLocaleString()}`}
                  </div>
                </a>
              ))}
            </div>
          </section>
        )}

        {/* FOUNDERS HERD — distinct visual card */}
        <section className="mt-10">
          <FounderCard
            foundersBacked={stats.foundersBacked}
            foundersCap={stats.foundersCap}
          />
        </section>

        {/* BRAND PARTNER — distinct visual card */}
        <section className="mt-4">
          <BrandCard />
        </section>

        {/* TESTIMONIAL — real quotes only */}
        {featured && (
          <blockquote className="mt-12 border-l-2 border-charcoal pl-5 text-charcoal italic text-base">
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

        {/* FOUNDER LINE */}
        <p className="mt-12 text-saddle text-center text-sm">
          built by ben, 26, from a truck. no ads. no vc.
        </p>

        {/* TERTIARY ROUTES — rancher join + share */}
        <footer className="mt-10 pt-6 border-t border-dust space-y-3 text-sm">
          <a
            href="/map/add-a-rancher"
            className="group flex items-baseline justify-between gap-4 py-2 hover:text-saddle transition-base"
          >
            <span>
              <span className="text-saddle">run a ranch? </span>
              <span className="text-charcoal underline underline-offset-2">
                join the network
              </span>
            </span>
            <span
              aria-hidden="true"
              className="text-charcoal transition-transform group-hover:translate-x-1"
            >
              →
            </span>
          </a>
          <a
            href="/access?ref=share"
            className="group flex items-baseline justify-between gap-4 py-2 hover:text-saddle transition-base"
          >
            <span>
              <span className="text-saddle">already love us? </span>
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
      <ExitIntentModal />
    </main>
  );
}
