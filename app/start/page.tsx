// /start — bio-link router page.
//
// Treated as a REVENUE FUNNEL ROUTER, not just a "who are you" picker.
// Above-fold scarcity bar + price-anchored CTAs in revenue-tier order
// drive every visitor toward the action that maps to their intent +
// our $-priority. Below the fold: stats, recent close (social proof of
// transaction velocity), real testimonial, share+earn affiliate hook.
//
// Shell is a Server Component. Click-tracking buttons + affiliate
// share UI are in client subcomponents so analytics fire without
// blocking SSR.

import type { Metadata } from 'next';
import StartButtons from './StartButtons';
import ExitIntentModal from '@/app/components/ExitIntentModal';
import { getRecentTestimonials, type Testimonial } from '@/lib/testimonials';
import { getAllRecords, getRecordById, TABLES } from '@/lib/airtable';

export const metadata: Metadata = {
  title: 'who are you? — buyhalfcow',
  description: "pick one. i'll route you in 5 seconds. real beef, real ranchers, direct.",
  openGraph: {
    title: 'who are you? — buyhalfcow',
    description: "pick one. i'll route you in 5 seconds.",
    type: 'website',
  },
};

// Revalidate every 5 min — stats don't need to be real-time on this page.
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
    // Fallback to known-good baseline if API unavailable at build time.
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

// Pulls the most recently Closed Won referral for the "just closed"
// strip. Privacy: first name + state only. Failure-safe: returns null,
// strip is hidden.
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

function formatDaysAgo(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

export default async function StartPage() {
  const [stats, testimonials, latestClose] = await Promise.all([
    fetchStats(),
    getRecentTestimonials(1),
    fetchLatestClose(),
  ]);
  const featured: Testimonial | null = testimonials[0] || null;
  const foundersLeft = Math.max(0, stats.foundersCap - stats.foundersBacked);
  const foundersPct = Math.min(100, (stats.foundersBacked / stats.foundersCap) * 100);

  return (
    <main className="min-h-screen bg-bone text-charcoal px-4 py-12 sm:py-20">
      <div className="mx-auto max-w-2xl">
        {/* ── HERO ──────────────────────────────────────────────────────── */}
        <h1 className="font-serif text-4xl sm:text-5xl mb-3 text-charcoal lowercase leading-tight">
          real beef. real ranchers. direct.
        </h1>
        <p className="text-saddle text-lg mb-8">
          pick one. i&apos;ll route you in 5 seconds.
        </p>

        {/* ── FOUNDING HERD SCARCITY BAR ───────────────────────────────── */}
        {foundersLeft > 0 ? (
          <div className="mb-8 bg-bone-warm border border-charcoal p-4">
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-xs uppercase tracking-wider text-saddle">
                founding herd
              </span>
              <span className="text-xs font-semibold text-charcoal">
                {stats.foundersBacked} / {stats.foundersCap} claimed
              </span>
            </div>
            <div className="h-2 bg-bone border border-dust overflow-hidden">
              <div
                className="h-full bg-charcoal"
                style={{ width: `${foundersPct}%` }}
                aria-label={`${stats.foundersBacked} of ${stats.foundersCap} founding members claimed`}
              />
            </div>
            <p className="text-xs text-saddle mt-2">
              {foundersLeft} spots left · $100 backs the mission · $15k locks
              founder #1-10 forever
            </p>
          </div>
        ) : (
          <div className="mb-8 bg-charcoal text-bone p-4">
            <p className="text-xs uppercase tracking-wider mb-1">founding herd</p>
            <p className="text-sm">
              all 100 spots claimed · waitlist + behind-the-scenes drops on /founders →
            </p>
          </div>
        )}

        {/* ── CTAs ─────────────────────────────────────────────────────── */}
        <StartButtons
          foundersBacked={stats.foundersBacked}
          foundersCap={stats.foundersCap}
        />

        {/* ── STATS ────────────────────────────────────────────────────── */}
        <div className="mt-14 grid grid-cols-3 gap-4 sm:gap-8">
          <div className="text-center">
            <div className="font-serif text-3xl sm:text-4xl text-charcoal">
              {stats.ranchersActive}
            </div>
            <div className="text-xs sm:text-sm text-saddle mt-1">verified ranchers</div>
          </div>
          <div className="text-center">
            <div className="font-serif text-3xl sm:text-4xl text-charcoal">
              {stats.familiesMatched.toLocaleString()}
            </div>
            <div className="text-xs sm:text-sm text-saddle mt-1">families in pipeline</div>
          </div>
          <div className="text-center">
            <div className="font-serif text-3xl sm:text-4xl text-charcoal">
              {stats.totalClosedWon}
            </div>
            <div className="text-xs sm:text-sm text-saddle mt-1">deals closed</div>
          </div>
        </div>

        {/* ── RECENT CLOSE — proof of transaction velocity ───────────── */}
        {latestClose && (
          <div className="mt-10 bg-bone-warm border-l-4 border-charcoal pl-4 py-3 pr-4">
            <p className="text-xs uppercase tracking-wider text-saddle mb-1">
              just closed · {formatDaysAgo(latestClose.daysAgo)}
            </p>
            <p className="text-sm text-charcoal">
              {latestClose.firstName} got a {latestClose.orderType.toLowerCase()} from{' '}
              {latestClose.ranchSlug ? (
                <a
                  href={`/ranchers/${latestClose.ranchSlug}`}
                  className="underline underline-offset-2 hover:text-saddle"
                >
                  {latestClose.ranchName}
                </a>
              ) : (
                latestClose.ranchName
              )}
              {latestClose.buyerState ? ` · ${latestClose.buyerState}` : ''}
            </p>
          </div>
        )}

        {/* ── FOUNDER LINE ─────────────────────────────────────────────── */}
        <p className="mt-12 text-saddle text-center text-sm sm:text-base">
          built by ben, 26, from a truck. no ads. no vc.
        </p>

        {/* ── TESTIMONIAL ──────────────────────────────────────────────── */}
        {featured ? (
          <blockquote className="mt-10 border-l-2 border-dust pl-6 text-charcoal italic">
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
        ) : (
          <blockquote className="mt-10 border-l-2 border-dust pl-6 text-charcoal italic">
            &ldquo;the beef showed up. so did my rancher&apos;s number. i call him direct
            now.&rdquo;
            <footer className="mt-2 text-sm text-saddle not-italic">
              — S.K., Colorado
            </footer>
          </blockquote>
        )}

        {/* ── SHARE + EARN RIBBON ──────────────────────────────────────
            Bottom hook for repeat visitors / fans. Drives compounded
            sign-ups via affiliate code. Existing /access thank-you
            already has the full affiliate flow — this is a top-of-funnel
            entry point for warm visitors. */}
        <div className="mt-16 pt-8 border-t border-dust">
          <p className="text-xs uppercase tracking-wider text-saddle mb-2">
            already love us?
          </p>
          <a
            href="/access?ref=share"
            className="inline-flex items-center gap-2 text-sm text-charcoal underline underline-offset-2 hover:text-saddle"
          >
            share your link · refer 3 friends · earn a free half →
          </a>
        </div>
      </div>
      <ExitIntentModal />
    </main>
  );
}
