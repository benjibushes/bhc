'use client';

// U17 — error boundary for the public rancher page (where paid ads land).
// Before this, any thrown error (an Airtable blip, a bad row) rendered Next's
// generic crash page — a dead-ended, wasted ad click. This gives the buyer a
// calm, on-brand recovery: retry the page, or step out to the map / quiz so
// they never hit a wall. notFound() is handled separately by not-found.tsx;
// this catches unexpected throws only.

import { useEffect } from 'react';
import Link from 'next/link';

export default function RancherPageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the console (and any error tracker wired later). The page-data
    // fetch already logs server-side; this captures the client boundary hit.
    console.error('[ranchers/[slug]] render error:', error?.message, error?.digest);
  }, [error]);

  return (
    <main className="min-h-screen bg-bone text-charcoal flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-5">
        <p className="text-xs uppercase tracking-[0.2em] text-saddle font-bold">Hmm — that didn&rsquo;t load</p>
        <h1 className="font-serif text-3xl md:text-4xl">We couldn&rsquo;t open this ranch just now.</h1>
        <p className="text-saddle leading-relaxed">
          It&rsquo;s almost certainly a momentary hiccup on our end, not you. Give it another try — or
          browse the map to find a rancher near you.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
          <button
            type="button"
            onClick={() => reset()}
            className="px-6 py-3 min-h-[48px] bg-charcoal text-bone text-sm font-medium uppercase tracking-wide transition-base hover:bg-saddle"
          >
            Try again
          </button>
          <Link
            href="/map"
            className="px-6 py-3 min-h-[48px] border border-charcoal text-sm font-medium uppercase tracking-wide transition-base hover:bg-charcoal hover:text-bone flex items-center justify-center"
          >
            Browse the map →
          </Link>
        </div>
        <p className="text-xs text-dust pt-2">
          Looking for beef near you? <Link href="/access" className="underline underline-offset-2 hover:text-charcoal">Take the 90-second quiz →</Link>
        </p>
      </div>
    </main>
  );
}
