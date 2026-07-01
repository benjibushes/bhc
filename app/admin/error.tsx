'use client';

// C1 — error boundary for the admin surface (/admin and all sub-pages).
// Before this, a render error on any admin page (a bad Airtable row, a metric
// endpoint blip) white-screened the whole console. This keeps the operator in
// place with a retry and a path back to the admin home.
// Client boundary: console.error only — no server-only code.

import { useEffect } from 'react';
import Link from 'next/link';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[admin] render error:', error?.message, error?.digest);
    console.error(error);
  }, [error]);

  return (
    <main className="min-h-screen bg-bone text-charcoal flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-5">
        <p className="text-xs uppercase tracking-[0.2em] text-saddle font-bold">That didn&rsquo;t load</p>
        <h1 className="font-serif text-3xl md:text-4xl">This admin page hit an error.</h1>
        <p className="text-saddle leading-relaxed">
          Likely a momentary data hiccup — the details are in the console log.
          Try again, or head back to the admin home.
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
            href="/admin"
            className="px-6 py-3 min-h-[48px] border border-charcoal text-sm font-medium uppercase tracking-wide transition-base hover:bg-charcoal hover:text-bone flex items-center justify-center"
          >
            Admin home
          </Link>
        </div>
        {error?.digest ? (
          <p className="text-xs text-dust pt-2">Error reference: {error.digest}</p>
        ) : null}
      </div>
    </main>
  );
}
