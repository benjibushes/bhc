// /start — 4-audience self-select landing page.
//
// Visitors arrive from bio links (IG/X/TikTok/LinkedIn) + don't know
// what role they fit. The page surfaces all 4 paths with equal visual
// weight + audience-specific proof points so each visitor self-selects
// in <5 seconds.
//
// Audiences:
//   1. BUYERS — find real beef in your state → /access
//   2. RANCHERS — sell direct, keep 90% → /map/add-a-rancher
//   3. BACKERS — back the founding herd → /founders
//   4. BRANDS — get in front of d2c ranchers → /brand-partners
//
// Each audience card carries:
//   - audience label (BUYERS / etc)
//   - scarcity or price anchor (right-aligned with label)
//   - headline (1-line value prop)
//   - 1-2 proof points (audience-specific stats)
//   - body copy (descriptive)
//   - CTA button label
//
// Layout: 2x2 grid on desktop, 1-col stack on mobile.
//
// Above the grid: hero + LIVE recent-close badge (proves network works).
// Below the grid: ranchers preview (logos), real testimonial, footer.

import type { Metadata } from 'next';
import { PageViewTracker, AudienceCard } from './StartButtons';
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
  description: "pick who you are. we route you in 5 seconds. buyers, ranchers, backers, brands.",
  openGraph: {
    title: 'buyhalfcow — real beef. real ranchers. direct.',
    description: "pick who you are. we route you in 5 seconds.",
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
  logoUrl: string;
}

async function fetchRancherPreview(): Promise<RancherPreview[]> {
  try {
    const ranchers = (await getActiveRancherPages()) as any[];
    if (ranchers.length === 0) return [];
    // Prefer ranchers WITH logos so the strip looks intentional.
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
      logoUrl: (r['Logo URL'] || '').toString(),
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

export default async function StartPage() {
  const [stats, testimonials, latestClose, ranchers] = await Promise.all([
    fetchStats(),
    getRecentTestimonials(1),
    fetchLatestClose(),
    fetchRancherPreview(),
  ]);
  const featured: Testimonial | null = testimonials[0] || null;
  const foundersLeft = Math.max(0, stats.foundersCap - stats.foundersBacked);
  const backerCardClaimed = stats.foundersBacked >= stats.foundersCap;

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <PageViewTracker />
      <div className="mx-auto max-w-4xl px-5 sm:px-6 py-10 sm:py-16">
        {/* HERO */}
        <div className="max-w-2xl mb-8">
          <h1 className="font-serif text-3xl sm:text-5xl text-charcoal lowercase leading-[1.05] mb-3">
            real beef. real ranchers. direct.
          </h1>
          <p className="text-saddle text-base sm:text-lg">
            pick who you are. we route you in 5 seconds.
          </p>
        </div>

        {/* LIVE RECENT CLOSE — proof network works, sits above audience grid */}
        {latestClose && (
          <div className="mb-8 inline-flex items-center gap-2 text-xs sm:text-sm">
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

        {/* ──────── AUDIENCE SELF-SELECT GRID ──────── */}
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          {/* BUYERS */}
          <AudienceCard
            href="/access"
            label="buyers"
            meta="free quiz · 90 sec"
            headline="find real beef in your state"
            proofLine1={`${stats.familiesMatched.toLocaleString()} families matched`}
            proofLine2={`${stats.totalClosedWon} deals closed`}
            body="we route you to a verified rancher in your state. you talk to them direct — no middleman, no markup."
            ctaLabel="get matched"
            route="buyer"
            variant="warm"
          />

          {/* RANCHERS */}
          <AudienceCard
            href="/map/add-a-rancher"
            label="ranchers"
            meta="free · 5-min setup"
            headline="sell direct · keep 90%"
            proofLine1={`${stats.ranchersActive} verified ranchers active`}
            proofLine2="we route buyers to you in your state"
            body="cut out grocery middlemen. set your prices, set your dates. we handle the routing, the email, the closing nudge. you raise the cattle."
            ctaLabel="join the network"
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
              proofLine2="waitlist + behind-the-scenes drops"
              body="the first 100 backers funded the platform you see today. follow the build, get first access to the next 100 spots."
              ctaLabel="view wins"
              route="founder"
              variant="dark"
            />
          ) : (
            <AudienceCard
              href="/founders"
              label="backers · founding herd"
              meta={`${stats.foundersBacked} / ${stats.foundersCap} claimed`}
              headline="back the food revolution"
              proofLine1={`${foundersLeft} of 100 spots left`}
              proofLine2="from $100 · $15k locks founder #1-10"
              body="fund the next 100 ranchers we onboard. lifetime founder status, quarterly behind-the-scenes drops, equity-in-mission ownership."
              ctaLabel="back the herd"
              route="founder"
              variant="dark"
            />
          )}

          {/* BRANDS */}
          <AudienceCard
            href="/brand-partners"
            label="brands"
            meta="from $99/mo"
            headline="get in front of d2c ranchers"
            proofLine1="$99 spotlight · $499 featured"
            proofLine2="$1,500 founding partner"
            body="logo placement on /map + /matched. pinned posts in member feed. access to ranchers + families who already buy direct."
            ctaLabel="see tiers"
            route="brand"
            variant="deep"
          />
        </section>

        {/* RANCHERS PREVIEW STRIP — visual proof of supply */}
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

        {/* REAL TESTIMONIAL — renders only if explicit Testimonial set */}
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

        {/* FOUNDER LINE + SHARE */}
        <footer className="mt-14 pt-8 border-t border-dust max-w-2xl">
          <p className="text-saddle text-sm mb-4">
            built by ben, 26, from a truck. no ads. no vc.
          </p>
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
      <ExitIntentModal />
    </main>
  );
}
