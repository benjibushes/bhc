// /start — bio-link router page. CRO Phase 1.
//
// Three large tappable buttons route to buyer (/access), rancher
// (/map/add-a-rancher), and brand (/brand-partners). Below the fold:
// live stats from /api/stats/public + founder line + testimonial.
//
// Shell is a Server Component. Click-tracking buttons are in StartButtons.tsx
// (Client Component) so analytics fire client-side without blocking SSR.

import type { Metadata } from 'next';
import StartButtons from './StartButtons';

export const metadata: Metadata = {
  title: 'who are you? — buyhalfcow',
  description: "pick one. i'll route you in 5 seconds.",
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
    // Fallback to known-good baseline numbers if the endpoint is unavailable
    // at build time. ISR will retry in 5 min.
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

export default async function StartPage() {
  const stats = await fetchStats();

  return (
    <main className="min-h-screen bg-bone text-charcoal px-4 py-12 sm:py-20">
      <div className="mx-auto max-w-2xl">
        {/* ── ABOVE THE FOLD ─────────────────────────────────────────── */}
        <h1 className="font-serif text-4xl sm:text-5xl mb-3 text-charcoal lowercase">
          who are you?
        </h1>
        <p className="text-saddle text-lg mb-10 sm:mb-12">
          pick one. i&apos;ll route you in 5 seconds.
        </p>

        {/* Client component handles analytics tracking */}
        <StartButtons />

        {/* ── BELOW THE FOLD ─────────────────────────────────────────── */}

        {/* Stat blocks — server-fetched, ISR 300s */}
        <div className="mt-16 grid grid-cols-3 gap-4 sm:gap-8">
          <div className="text-center">
            <div className="font-serif text-3xl sm:text-4xl text-charcoal">
              {stats.ranchersActive}
            </div>
            <div className="text-xs sm:text-sm text-saddle mt-1">ranchers</div>
          </div>
          <div className="text-center">
            <div className="font-serif text-3xl sm:text-4xl text-charcoal">
              {stats.familiesMatched.toLocaleString()}
            </div>
            <div className="text-xs sm:text-sm text-saddle mt-1">families</div>
          </div>
          <div className="text-center">
            {/* Hardcoded — brand-known stat, not surfaced from the API */}
            <div className="font-serif text-3xl sm:text-4xl text-charcoal">
              $20K+
            </div>
            <div className="text-xs sm:text-sm text-saddle mt-1">in 4 weeks</div>
          </div>
        </div>

        {/* Founder line */}
        <p className="mt-12 text-saddle text-center text-sm sm:text-base">
          built by ben, 26, from a truck. no ads. no vc.
        </p>

        {/* Testimonial */}
        {/* TODO: real testimonial */}
        <blockquote className="mt-12 border-l-2 border-dust pl-6 text-charcoal italic">
          &ldquo;the beef showed up. so did my rancher&apos;s number. i call him direct
          now.&rdquo;
          <footer className="mt-2 text-sm text-saddle not-italic">
            — S.K., Colorado
          </footer>
        </blockquote>
      </div>
    </main>
  );
}
