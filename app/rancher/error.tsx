'use client';

// C1 — error boundary for the rancher cockpit (/rancher and all sub-pages:
// setup, billing, inbox, cal, connected). Before this, a render error dropped
// a working rancher onto the root crash page mid-task. This keeps them inside
// their cockpit with a retry and a path back to the dashboard.
// Client boundary: console.error only — no server-only code.

import { useEffect } from 'react';
import Link from 'next/link';

export default function RancherError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[rancher] render error:', error?.message, error?.digest);
    console.error(error);
  }, [error]);

  return (
    <main className="min-h-screen bg-bone text-charcoal flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-5">
        <p className="text-xs uppercase tracking-[0.2em] text-saddle font-bold">That didn&rsquo;t load</p>
        <h1 className="font-serif text-3xl md:text-4xl">Your dashboard hit a hiccup.</h1>
        <p className="text-saddle leading-relaxed">
          A momentary error on our end — your data is safe and nothing you did caused it.
          Try again, or head back to your dashboard.
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
            href="/rancher"
            className="px-6 py-3 min-h-[48px] border border-charcoal text-sm font-medium uppercase tracking-wide transition-base hover:bg-charcoal hover:text-bone flex items-center justify-center"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
