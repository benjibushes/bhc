'use client';

// C1 — error boundary for the checkout segment (the deposit money path).
// Before this, a render error here fell through to the root boundary — or a
// raw crash screen — at the exact moment a buyer is trying to pay. This gives
// them a calm retry and a human fallback. Payment itself happens on Stripe's
// side, so a page error here never means a charge went through silently.
// Client boundary: console.error only — no server-only code.

import { useEffect } from 'react';
import Link from 'next/link';

export default function CheckoutError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[checkout] render error:', error?.message, error?.digest);
    console.error(error);
  }, [error]);

  return (
    <main className="min-h-screen bg-bone text-charcoal flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-5">
        <p className="text-xs uppercase tracking-[0.2em] text-saddle font-bold">Checkout hit a snag</p>
        <h1 className="font-serif text-3xl md:text-4xl">Your reservation isn&rsquo;t lost.</h1>
        <p className="text-saddle leading-relaxed">
          The page hit a momentary error on our end — you haven&rsquo;t been charged by it.
          Try again, and if it keeps happening email hello@buyhalfcow.com and we&rsquo;ll
          finish your reservation by hand.
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
            href="/"
            className="px-6 py-3 min-h-[48px] border border-charcoal text-sm font-medium uppercase tracking-wide transition-base hover:bg-charcoal hover:text-bone flex items-center justify-center"
          >
            Go home
          </Link>
        </div>
        <p className="text-xs text-dust pt-2">
          Need a hand right now?{' '}
          <a href="mailto:hello@buyhalfcow.com" className="underline underline-offset-2 hover:text-charcoal">
            Email hello@buyhalfcow.com
          </a>
        </p>
      </div>
    </main>
  );
}
