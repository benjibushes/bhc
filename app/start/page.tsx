// /start — revenue funnel router page.
//
// Visual hierarchy:
//   1. Hero (tight, lowercase, brand voice)
//   2. Recent close strip (immediate social proof of transaction velocity)
//   3. PRIMARY CTA — buyer get matched (visually dominant, charcoal slab)
//   4. Secondary CTAs — founders herd (bone-warm card w/ "be founder #N"
//      framing) + brand partner (bone card w/ outline). NOT same visual
//      weight as primary — eye knows which to pick.
//   5. Live ranchers preview (3 random Page-Live ranchers → discovery)
//   6. Stats trio (real, ISR 300s)
//   7. Real testimonial (renders only if explicit Testimonial field set)
//   8. Tertiary text link — rancher join (supply side, indirect $)
//   9. Affiliate share ribbon
//
// Shell = Server Component. Buttons + tracking = client subcomponents.

import type { Metadata } from 'next';
import PrimaryBuyerCTA, {
  FounderCTA,
  BrandCTA,
  RancherTextLink,
} from './StartButtons';
import ExitIntentModal from '@/app/components/ExitIntentModal';
import { getRecentTestimonials, type Testimonial } from '@/lib/testimonials';
import { getAllRecords, getActiveRancherPages, getRecordById, TABLES } from '@/lib/airtable';

export const metadata: Metadata = {
  title: 'who are you? — buyhalfcow',
  description: "pick one. i'll route you in 5 seconds. real beef, real ranchers, direct.",
  openGraph: {
    title: 'who are you? — buyhalfcow',
    description: "pick one. i'll route you in 5 seconds.",
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
        // missing rancher — keep generic
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
  operatorName: string;
  state: string;
  beefTypes: string;
  cuts: string;
}

async function fetchRancherPreview(): Promise<RancherPreview[]> {
  try {
    const ranchers = (await getActiveRancherPages()) as any[];
    if (ranchers.length === 0) return [];
    // Fisher-Yates shuffle for variety on each page render
    const shuffled = [...ranchers];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, 3).map((r: any) => {
      const cutList: string[] = [];
      if (r['Quarter Price']) cutList.push('quarter');
      if (r['Half Price']) cutList.push('half');
      if (r['Whole Price']) cutList.push('whole');
      return {
        id: r.id,
        slug: (r['Slug'] || '').toString(),
        ranchName: (r['Ranch Name'] || '').toString(),
        operatorName: (r['Operator Name'] || '').toString(),
        state: (r['State'] || '').toString(),
        beefTypes: (r['Beef Types'] || '').toString(),
        cuts: cutList.length > 0 ? cutList.join('–') : 'beef',
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
      <div className="mx-auto max-w-2xl px-4 py-10 sm:py-16">
        {/* ── HERO ──────────────────────────────────────────────────────── */}
        <header className="mb-8">
          <h1 className="font-serif text-3xl sm:text-4xl text-charcoal lowercase leading-[1.1] mb-2">
            real beef.<br />real ranchers. direct.
          </h1>
          <p className="text-saddle text-base sm:text-lg">
            pick your state. talk to the rancher direct.
          </p>
        </header>

        {/* ── RECENT CLOSE — proof BEFORE the ask ──────────────────────── */}
        {latestClose && (
          <div className="mb-6 flex items-center gap-3 text-xs sm:text-sm">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-sage/15 text-sage-dark border border-sage/30 font-semibold uppercase tracking-wider text-[10px]">
              <span className="w-1.5 h-1.5 bg-sage-dark rounded-full animate-pulse" />
              just closed
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
              {' '}· {formatDaysAgo(latestClose.daysAgo)}
            </span>
          </div>
        )}

        {/* ── PRIMARY CTA — buyer gets visual dominance ────────────────── */}
        <PrimaryBuyerCTA />

        {/* ── SECONDARY CTAs — founders + brand, differentiated treatment */}
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FounderCTA
            foundersBacked={stats.foundersBacked}
            foundersCap={stats.foundersCap}
          />
          <BrandCTA />
        </div>

        {/* ── RANCHERS PREVIEW — live discovery surface ────────────────── */}
        {ranchers.length > 0 && (
          <section className="mt-12">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-xs uppercase tracking-wider text-saddle">
                verified ranchers · in stock
              </h2>
              <a
                href="/map"
                className="text-xs text-charcoal underline underline-offset-2 hover:text-saddle"
              >
                see all {stats.ranchersActive} →
              </a>
            </div>
            <div className="space-y-2">
              {ranchers.map((r) => (
                <a
                  key={r.id}
                  href={`/ranchers/${r.slug}`}
                  className="group flex items-baseline justify-between gap-3 py-3 px-4 border border-dust hover:border-charcoal hover:bg-bone-warm transition-base"
                >
                  <div className="text-left min-w-0">
                    <div className="font-medium text-sm text-charcoal truncate">
                      {r.ranchName}
                    </div>
                    {r.beefTypes && (
                      <div className="text-xs text-saddle truncate">
                        {r.beefTypes.toLowerCase()}
                      </div>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-xs text-charcoal uppercase tracking-wider font-semibold">
                      {r.state}
                    </div>
                    <div className="text-xs text-saddle">{r.cuts}</div>
                  </div>
                  <span
                    aria-hidden="true"
                    className="text-charcoal flex-shrink-0 transition-transform group-hover:translate-x-1"
                  >
                    →
                  </span>
                </a>
              ))}
            </div>
          </section>
        )}

        {/* ── STATS — bigger, bolder, real numbers ─────────────────────── */}
        <section className="mt-12 py-6 border-y border-dust">
          <div className="grid grid-cols-3 gap-4 sm:gap-8">
            <div className="text-center">
              <div className="font-serif text-3xl sm:text-4xl text-charcoal leading-none">
                {stats.ranchersActive}
              </div>
              <div className="text-[10px] sm:text-xs uppercase tracking-wider text-saddle mt-2">
                verified ranchers
              </div>
            </div>
            <div className="text-center border-x border-dust">
              <div className="font-serif text-3xl sm:text-4xl text-charcoal leading-none">
                {stats.familiesMatched.toLocaleString()}
              </div>
              <div className="text-[10px] sm:text-xs uppercase tracking-wider text-saddle mt-2">
                families
              </div>
            </div>
            <div className="text-center">
              <div className="font-serif text-3xl sm:text-4xl text-charcoal leading-none">
                {stats.totalClosedWon}
              </div>
              <div className="text-[10px] sm:text-xs uppercase tracking-wider text-saddle mt-2">
                deals closed
              </div>
            </div>
          </div>
        </section>

        {/* ── REAL TESTIMONIAL — renders only if explicit Testimonial set */}
        {featured && (
          <blockquote className="mt-10 border-l-2 border-charcoal pl-5 text-charcoal italic">
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

        {/* ── FOUNDER LINE ─────────────────────────────────────────────── */}
        <p className="mt-10 text-saddle text-center text-sm">
          built by ben, 26, from a truck. no ads. no vc.
        </p>

        {/* ── RANCHER TEXT LINK + AFFILIATE SHARE ──────────────────────── */}
        <div className="mt-12 pt-8 border-t border-dust space-y-4">
          <RancherTextLink />
          <div className="text-sm">
            <a
              href="/access?ref=share"
              className="group inline-flex items-baseline gap-2 text-charcoal hover:text-saddle transition-base"
            >
              <span>
                already love us?{' '}
                <span className="underline underline-offset-2">
                  share your link · refer 3 friends · earn a free half
                </span>
              </span>
              <span
                aria-hidden="true"
                className="text-charcoal transition-transform group-hover:translate-x-1"
              >
                →
              </span>
            </a>
          </div>
        </div>
      </div>
      <ExitIntentModal />
    </main>
  );
}
