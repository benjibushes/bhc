'use client';

// C1 — error boundary for the member area (/member and sub-pages). Before
// this, a render error dropped a signed-in buyer onto the root crash page.
// This keeps them in the member area with a retry and a path back to their
// member home. Client boundary: console.error only — no server-only code.

import { useEffect } from 'react';
import Link from 'next/link';

export default function MemberError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[member] render error:', error?.message, error?.digest);
    console.error(error);
  }, [error]);

  return (
    <main className="min-h-screen bg-bone text-charcoal flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-5">
        <p className="text-xs uppercase tracking-[0.2em] text-saddle font-bold">That didn&rsquo;t load</p>
        <h1 className="font-serif text-3xl md:text-4xl">We couldn&rsquo;t open this page just now.</h1>
        <p className="text-saddle leading-relaxed">
          A momentary hiccup on our end — your account and reservation are untouched.
          Try again, or head back to your member home.
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
            href="/member"
            className="px-6 py-3 min-h-[48px] border border-charcoal text-sm font-medium uppercase tracking-wide transition-base hover:bg-charcoal hover:text-bone flex items-center justify-center"
          >
            Member home
          </Link>
        </div>
      </div>
    </main>
  );
}
