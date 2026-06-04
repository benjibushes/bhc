// app/qualify/page.tsx — bare /qualify (no consumerId in path).
//
// Lands here from: stale shared link, mistyped URL, ad lander that lost
// the params, or anyone curious. Renders a friendly recovery state with
// path back to /access. Never 404s.

import Link from 'next/link';

export const metadata = {
  title: 'Confirm your match · BuyHalfCow',
  description: 'Looks like your invite link expired. Start a new application to get matched with a verified rancher.',
};

export default function QualifyLandingPage() {
  return (
    <main className="min-h-screen bg-bone flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white border border-dust p-7 md:p-8 text-center space-y-4">
        <div className="text-4xl">🐂</div>
        <p className="text-xs uppercase tracking-widest text-saddle">Match confirmation</p>
        <h1 className="font-serif text-2xl text-charcoal">Looks like your invite link expired</h1>
        <p className="text-sm text-saddle leading-relaxed">
          The qualification page needs a specific link from your welcome email. If you can&apos;t
          find it, the fastest way back in is to start a fresh application — takes 30 seconds and you&apos;ll
          get a new invite within a minute.
        </p>
        <div className="pt-2">
          <Link
            href="/access"
            className="inline-block px-7 py-3 bg-charcoal text-bone hover:bg-saddle transition-colors font-medium uppercase tracking-widest text-xs"
          >
            Start your application →
          </Link>
        </div>
        <p className="text-xs text-dust pt-3 border-t border-dust">
          Already applied? Check your inbox for the &ldquo;Yes — Ready to Buy&rdquo; email and click the button
          inside it to land back here with a fresh link.
        </p>
      </div>
    </main>
  );
}
