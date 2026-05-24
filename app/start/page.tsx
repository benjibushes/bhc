// /start — editorial-style bio router. Quiet typography, whitespace as
// design tool, single primary CTA, secondary routes as text-link rows.
//
// Hierarchy:
//   1. Hero (tight serif headline + subhead)
//   2. Recent close (1-line italic proof, no badges/borders)
//   3. PRIMARY CTA — buyer (single clean charcoal button)
//   4. Stats line (real, comma-separated)
//   5. Verified ranchers list (clean text rows, no boxes)
//   6. Secondary routes (founders / brand / rancher join — quiet text-link rows)
//   7. Testimonial (real quote only, hides if empty)
//   8. Footer (founder line + share)

import type { Metadata } from 'next';
import PrimaryBuyerCTA, { SecondaryLink } from './StartButtons';
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
}

async function fetchRancherPreview(): Promise<RancherPreview[]> {
  try {
    const ranchers = (await getActiveRancherPages()) as any[];
    if (ranchers.length === 0) return [];
    const shuffled = [...ranchers];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, 3).map((r: any) => ({
      id: r.id,
      slug: (r['Slug'] || '').toString(),
      ranchName: (r['Ranch Name'] || '').toString(),
      state: (r['State'] || '').toString(),
      beefTypes: (r['Beef Types'] || '').toString(),
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

export default async function StartPage() {
  const [stats, testimonials, latestClose, ranchers] = await Promise.all([
    fetchStats(),
    getRecentTestimonials(1),
    fetchLatestClose(),
    fetchRancherPreview(),
  ]);
  const featured: Testimonial | null = testimonials[0] || null;
  const foundersLeft = Math.max(0, stats.foundersCap - stats.foundersBacked);

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="mx-auto max-w-xl px-5 sm:px-6 py-14 sm:py-20">
        {/* HERO */}
        <h1 className="font-serif text-3xl sm:text-4xl text-charcoal lowercase leading-[1.05] mb-3">
          real beef.<br />
          real ranchers.<br />
          direct.
        </h1>
        <p className="text-saddle text-base mb-10">
          pick your state. talk to the rancher direct.
        </p>

        {/* RECENT CLOSE — quiet single line */}
        {latestClose && (
          <p className="text-sm text-saddle italic mb-8">
            just closed · {latestClose.firstName} got a{' '}
            {latestClose.orderType.toLowerCase()} from{' '}
            {latestClose.ranchSlug ? (
              <a
                href={`/ranchers/${latestClose.ranchSlug}`}
                className="text-charcoal not-italic hover:underline"
              >
                {latestClose.ranchName}
              </a>
            ) : (
              <span className="text-charcoal not-italic">{latestClose.ranchName}</span>
            )}
            {latestClose.buyerState && ` · ${latestClose.buyerState}`}
            {' · '}
            {formatDaysAgo(latestClose.daysAgo)}
          </p>
        )}

        {/* PRIMARY CTA */}
        <PrimaryBuyerCTA />

        {/* STATS — minimal, single line on desktop */}
        <p className="mt-8 text-sm text-saddle">
          <span className="text-charcoal font-medium">{stats.ranchersActive}</span> verified
          ranchers ·{' '}
          <span className="text-charcoal font-medium">
            {stats.familiesMatched.toLocaleString()}
          </span>{' '}
          families ·{' '}
          <span className="text-charcoal font-medium">{stats.totalClosedWon}</span> deals
          closed
        </p>

        {/* RANCHERS PREVIEW — clean rows, no boxes */}
        {ranchers.length > 0 && (
          <section className="mt-12">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="text-xs uppercase tracking-wider text-saddle">
                ranchers in stock
              </h2>
              <a
                href="/map"
                className="text-xs text-saddle hover:text-charcoal underline underline-offset-2"
              >
                see all {stats.ranchersActive}
              </a>
            </div>
            <div>
              {ranchers.map((r) => (
                <a
                  key={r.id}
                  href={`/ranchers/${r.slug}`}
                  className="group flex items-baseline justify-between gap-4 py-3 border-b border-dust hover:border-charcoal transition-base"
                >
                  <span className="text-charcoal min-w-0 truncate">
                    {r.ranchName}
                    {r.beefTypes && (
                      <span className="text-saddle text-sm ml-2 normal-case">
                        · {r.beefTypes.toLowerCase()}
                      </span>
                    )}
                  </span>
                  <span className="flex items-baseline gap-3 flex-shrink-0">
                    <span className="text-xs uppercase tracking-wider text-saddle">
                      {r.state}
                    </span>
                    <span
                      aria-hidden="true"
                      className="text-charcoal transition-transform group-hover:translate-x-1"
                    >
                      →
                    </span>
                  </span>
                </a>
              ))}
            </div>
          </section>
        )}

        {/* SECONDARY ROUTES — quiet text-link rows */}
        <section className="mt-12">
          <h2 className="text-xs uppercase tracking-wider text-saddle mb-4">
            also
          </h2>
          {foundersLeft > 0 ? (
            <SecondaryLink
              href="/founders"
              label="back the founding herd"
              meta={`${stats.foundersBacked} / ${stats.foundersCap} claimed · from $100`}
              route="founder"
            />
          ) : (
            <SecondaryLink
              href="/wins"
              label="see what the herd built"
              meta="herd full · waitlist"
              route="founder"
            />
          )}
          <SecondaryLink
            href="/brand-partners"
            label="become a brand partner"
            meta="from $99/mo"
            route="brand"
          />
          <SecondaryLink
            href="/map/add-a-rancher"
            label="run a ranch · join the network"
            meta="free · keep 90%"
            route="rancher"
          />
        </section>

        {/* TESTIMONIAL — real only */}
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

        {/* FOOTER */}
        <footer className="mt-16 pt-8 border-t border-dust space-y-3 text-sm">
          <p className="text-saddle">
            built by ben, 26, from a truck. no ads. no vc.
          </p>
          <a
            href="/access?ref=share"
            className="block text-saddle hover:text-charcoal underline underline-offset-2"
          >
            already love us? share + earn a free half
          </a>
        </footer>
      </div>
      <ExitIntentModal />
    </main>
  );
}
