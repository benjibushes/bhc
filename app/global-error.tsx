'use client';

// C1 — top-level error boundary. This renders ONLY when the root layout itself
// throws, which means it replaces layout.tsx entirely — so per Next.js rules it
// must render its own <html> and <body>, and it can't rely on the fonts/CSS the
// root layout would have loaded. We import globals.css and the same next/font
// pairs here so the fallback still looks like BuyHalfCow, not a browser default.
// Client boundary: console.error only — no server-only code (Sentry etc. is a
// separate slice).

import { useEffect } from 'react';
import { Playfair_Display, Inter } from 'next/font/google';
import './globals.css';

const playfair = Playfair_Display({
  variable: '--font-playfair',
  subsets: ['latin'],
  display: 'swap',
});

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global-error] root render error:', error?.message, error?.digest);
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className={`${playfair.variable} ${inter.variable} antialiased`}>
        <main className="min-h-screen bg-bone text-charcoal flex items-center justify-center px-4">
          <div className="max-w-md w-full text-center space-y-5">
            <p className="text-xs uppercase tracking-[0.2em] text-saddle font-bold">Something went wrong</p>
            <h1 className="font-serif text-3xl md:text-4xl">The page hit an unexpected error.</h1>
            <p className="text-saddle leading-relaxed">
              It&rsquo;s on our end, not you, and it&rsquo;s logged. Try again — or if it keeps
              happening, email hello@buyhalfcow.com and we&rsquo;ll sort it out.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
              <button
                type="button"
                onClick={() => reset()}
                className="px-6 py-3 min-h-[48px] bg-charcoal text-bone text-sm font-medium uppercase tracking-wide transition-base hover:bg-saddle"
              >
                Try again
              </button>
              <a
                href="/"
                className="px-6 py-3 min-h-[48px] border border-charcoal text-sm font-medium uppercase tracking-wide transition-base hover:bg-charcoal hover:text-bone flex items-center justify-center"
              >
                Go home
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
