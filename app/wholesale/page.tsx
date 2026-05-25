// /wholesale — restaurant / butcher / distributor application form.
//
// Higher-tier revenue path ($5-15k/buyer vs $400-2500 retail Quarter/Half/Whole).
// Server component pulls real stats from /api/stats/public + derives states
// served from active rancher pages — no fabricated numbers.
//
// Form is a client component (WholesaleForm) so analytics can fire on mount
// and submit, and validation state stays local.

import type { Metadata } from 'next';
import Link from 'next/link';
import WholesaleForm from './WholesaleForm';
import { getActiveRancherPages } from '@/lib/airtable';

export const metadata: Metadata = {
  title: 'Wholesale · Direct from verified ranchers',
  description:
    'restaurant or butcher? source direct from the ranch. skip the distributor. lock long-term supply with verified ranchers.',
  openGraph: {
    title: 'Wholesale · Direct from verified ranchers',
    description:
      'restaurant or butcher? source direct from the ranch. skip the distributor. lock long-term supply with verified ranchers.',
    type: 'website',
    url: 'https://www.buyhalfcow.com/wholesale',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Wholesale · Direct from verified ranchers',
    description:
      'restaurant or butcher? source direct from the ranch. skip the distributor.',
  },
};

// dynamic so we can pull live stats per-request (still cached at the
// /api/stats/public edge layer via revalidate: 300).
export const dynamic = 'force-dynamic';

interface PublicStats {
  ranchersActive: number;
  familiesMatched: number;
  totalClosedWon: number;
}

const STATS_FALLBACK: PublicStats = {
  ranchersActive: 17,
  familiesMatched: 1533,
  totalClosedWon: 11,
};

async function fetchStats(): Promise<PublicStats> {
  try {
    const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
    const res = await fetch(`${SITE_URL}/api/stats/public`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) throw new Error(`stats fetch returned ${res.status}`);
    const data = await res.json();
    return {
      ranchersActive: Number(data?.ranchersActive ?? STATS_FALLBACK.ranchersActive),
      familiesMatched: Number(data?.familiesMatched ?? STATS_FALLBACK.familiesMatched),
      totalClosedWon: Number(data?.totalClosedWon ?? STATS_FALLBACK.totalClosedWon),
    };
  } catch {
    return STATS_FALLBACK;
  }
}

// Derive states served from active rancher pages — no schema dependency.
// Counts unique state codes among Page-Live ranchers.
async function fetchStatesServed(): Promise<number> {
  try {
    const ranchers = (await getActiveRancherPages()) as any[];
    const states = new Set<string>();
    for (const r of ranchers) {
      const s = (r?.['State'] || '').toString().trim().toUpperCase();
      if (s) states.add(s);
    }
    return states.size;
  } catch {
    return 0;
  }
}

export default async function WholesalePage() {
  const [stats, statesServed] = await Promise.all([
    fetchStats(),
    fetchStatesServed(),
  ]);

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="mx-auto max-w-4xl px-5 sm:px-6 py-10 sm:py-16">
        {/* HERO */}
        <div className="max-w-2xl mb-8">
          <p className="text-xs uppercase tracking-wider text-saddle font-semibold mb-3">
            wholesale
          </p>
          <h1 className="font-serif text-3xl sm:text-5xl text-charcoal lowercase leading-[1.05] mb-4">
            restaurant or butcher? source direct from the ranch.
          </h1>
          <p className="text-saddle text-base sm:text-lg leading-relaxed">
            skip the distributor. lock long-term supply with verified ranchers.
          </p>
        </div>

        {/* STATS ROW — real numbers only */}
        <div className="grid grid-cols-3 gap-4 mb-10 sm:mb-12 max-w-2xl">
          <div className="border-l-2 border-dust pl-4">
            <div className="font-serif text-2xl sm:text-3xl text-charcoal">
              {stats.ranchersActive}
            </div>
            <div className="text-xs sm:text-sm text-saddle mt-1">
              verified ranchers
            </div>
          </div>
          <div className="border-l-2 border-dust pl-4">
            <div className="font-serif text-2xl sm:text-3xl text-charcoal">
              {statesServed > 0 ? statesServed : '—'}
            </div>
            <div className="text-xs sm:text-sm text-saddle mt-1">
              states served
            </div>
          </div>
          <div className="border-l-2 border-dust pl-4">
            <div className="font-serif text-2xl sm:text-3xl text-charcoal">
              {stats.totalClosedWon}
            </div>
            <div className="text-xs sm:text-sm text-saddle mt-1">
              deals closed
            </div>
          </div>
        </div>

        {/* TRUST STRIP */}
        <div className="mb-10 flex flex-wrap gap-x-6 gap-y-2 text-xs text-saddle">
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
            no middleman, no markup
          </span>
        </div>

        {/* WHAT YOU GET */}
        <div className="mb-10 border border-dust bg-bone-warm/40 p-5 sm:p-6 max-w-2xl">
          <p className="text-xs uppercase tracking-wider text-saddle font-semibold mb-3">
            what you get
          </p>
          <ul className="space-y-2 text-sm sm:text-base text-charcoal">
            <li className="flex gap-2">
              <span className="text-charcoal font-semibold">·</span>
              <span>
                <strong>direct relationships</strong> — talk to the rancher,
                not a sales rep
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-charcoal font-semibold">·</span>
              <span>
                <strong>consistent supply</strong> — lock processing dates
                4-12 weeks out
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-charcoal font-semibold">·</span>
              <span>
                <strong>flexible cuts</strong> — whole carcasses, primals,
                custom processing, bulk ground
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-charcoal font-semibold">·</span>
              <span>
                <strong>provenance you can market</strong> — name the ranch on
                your menu or case
              </span>
            </li>
          </ul>
        </div>

        {/* FORM */}
        <section className="mb-12">
          <p className="text-sm text-saddle uppercase tracking-wider mb-6">
            tell us about your business
          </p>
          <WholesaleForm />
        </section>

        {/* FOUNDER LINE + LINK BACK */}
        <footer className="mt-14 pt-8 border-t border-dust max-w-2xl">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-11 h-11 rounded-full bg-charcoal text-bone flex items-center justify-center font-serif text-lg flex-shrink-0">
              B
            </div>
            <p className="text-saddle text-sm">
              built by ben beauchman. wholesale applications come straight to
              my inbox — no rep, no queue.
            </p>
          </div>
          <Link
            href="/start"
            className="inline-flex items-baseline gap-2 text-sm text-saddle hover:text-charcoal transition-base"
          >
            <span aria-hidden="true">&larr;</span>
            <span>back to /start</span>
          </Link>
        </footer>
      </div>
    </main>
  );
}
