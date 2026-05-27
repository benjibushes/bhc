// Ceremonial handoff page — fires after a buyer clicks YES on a warmup email
// and matching/suggest successfully creates a referral. Replaces the prior
// drop-the-buyer-on-the-dashboard experience that gave them nothing visible
// to confirm the YES click did anything.
//
// Pattern from research (Crowd Cow early days + Superhuman onboarding): the
// moment between "I asked for a match" and "the rancher emails me" is the
// highest-anxiety point in the funnel. Show the buyer something real (rancher
// name + bio + what to expect) so they don't bounce thinking the form broke.
//
// Query params:
//   ?rancher={name}
//   &state={2-letter}
//   &pending={true}   ← Project 2 onboarding-throttle gate. When set, render
//                       the founder-vetting variant: rancher just went live,
//                       Ben is personally vetting the match before letting
//                       the rancher reach out. Sets 24-48h expectation.
// Public page — no auth required. The buyer is already logged in via the
// session cookie /api/warmup/engage set, but this page renders even without it.

import type { Metadata } from 'next';
import Link from 'next/link';
import Container from '../components/Container';
import Divider from '../components/Divider';
import MerchCTA from './MerchCTA';

export const dynamic = 'force-dynamic'; // query params change per visit

export const metadata: Metadata = {
  title: "You're matched",
  description: 'Your rancher introduction has been sent. Expect direct contact within 24-48 hours.',
  // noindex — this is a per-visit ceremonial confirmation page, not a
  // marketing surface. Indexing the placeholder copy would muddy SEO.
  robots: { index: false, follow: false },
};

type Props = {
  searchParams: Promise<{ rancher?: string; state?: string; pending?: string }>;
};

export default async function MatchedPage({ searchParams }: Props) {
  const params = await searchParams;
  const hasRancherParam = !!(params.rancher && params.rancher.trim());
  const rancherName = (params.rancher || 'your rancher').trim() || 'your rancher';
  const stateLabel = (params.state || '').trim().toUpperCase() || 'your state';
  const isPending = (params.pending || '').toLowerCase() === 'true';

  // No rancher in query string = user landed here directly (back button,
  // deeplink, manual URL). Show an explicit "are you lost?" state instead
  // of pretending we matched them. Audit finding 2026-05-20 #27.
  if (!hasRancherParam && !isPending) {
    return (
      <main className="min-h-screen bg-bone py-16 md:py-24">
        <Container>
          <div className="max-w-2xl mx-auto bg-white border border-dust p-10 md:p-14 text-center">
            <h1 className="font-serif text-3xl md:text-4xl mb-4 text-charcoal">
              No active match found
            </h1>
            <p className="text-base text-saddle mb-8">
              This page shows your most recent rancher introduction — but the link you followed didn&apos;t include one. Head to your dashboard for the latest, or apply for access if you&apos;re new.
            </p>
            <Divider />
            <div className="flex flex-col md:flex-row gap-3 justify-center mt-8">
              <a href="/member" className="block px-6 py-3 bg-charcoal text-bone text-sm uppercase tracking-wide">Open your dashboard</a>
              <a href="/access" className="block px-6 py-3 border border-charcoal text-charcoal text-sm uppercase tracking-wide">Apply for access</a>
            </div>
          </div>
        </Container>
      </main>
    );
  }

  if (isPending) {
    return (
      <main className="min-h-screen bg-bone py-12 md:py-24">
        <Container>
          <div className="max-w-2xl mx-auto bg-white border border-dust p-6 md:p-14 text-center">
            <div className="text-5xl md:text-6xl mb-6" aria-hidden="true">🤝</div>
            <h1 className="font-serif text-2xl md:text-4xl mb-4 text-charcoal">
              You&rsquo;re in.
            </h1>
            <p className="text-base text-saddle mb-8 leading-relaxed">
              I&rsquo;m personally vetting your match with {rancherName} before
              they reach out &mdash; expect 24&ndash;48h.
            </p>

            <Divider />

            <div className="text-left bg-bone-warm border-l-4 border-charcoal p-4 md:p-6 my-8 space-y-3">
              <p className="text-sm text-charcoal leading-relaxed">
                <strong>Why the pause?</strong> {rancherName} is new to the
                network and I&rsquo;m hand-checking every intro for the first
                week. It&rsquo;s how I keep the bar high &mdash; for you and for them.
              </p>
              <p className="text-sm text-charcoal leading-relaxed">
                <strong>What happens next:</strong> within 24&ndash;48 hours
                you&rsquo;ll hear from {rancherName} directly. They&rsquo;ll
                cover pricing, the next processing date, and how delivery works.
              </p>
              <p className="text-sm text-charcoal leading-relaxed">
                <strong>Heads up:</strong> the call usually comes from a
                {' '}{stateLabel} area code on the rancher&rsquo;s personal phone,
                not an 800 number. Don&rsquo;t miss it.
              </p>
            </div>

            <Divider />

            <p className="text-xs text-saddle mt-8 leading-relaxed">
              Reply to my last email if you have questions. I&rsquo;ll respond personally.
            </p>

            <p className="text-xs text-saddle mt-2">&mdash; Ben</p>

            <div className="mt-8">
              <Link href="/member" className="text-sm underline text-charcoal hover:text-saddle transition-colors">
                Or open your member dashboard &rarr;
              </Link>
            </div>
          </div>
        </Container>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-bone py-12 md:py-24">
      <Container>
        <div className="max-w-2xl mx-auto bg-white border border-dust p-6 md:p-14 text-center">
          <div className="text-5xl md:text-6xl mb-6" aria-hidden="true">🤝</div>
          <h1 className="font-serif text-2xl md:text-4xl mb-4 text-charcoal">
            You&rsquo;re matched with {rancherName}.
          </h1>
          <p className="text-base text-saddle mb-8 leading-relaxed">
            Your YES went through. {rancherName} just got an email with your
            name, state, and what you&rsquo;re looking for.
          </p>

          <Divider />

          <div className="text-left bg-bone-warm border-l-4 border-charcoal p-4 md:p-6 my-8 space-y-3">
            <p className="text-sm text-charcoal leading-relaxed">
              <strong>Next 24&ndash;48 hours:</strong> {rancherName} reaches out
              direct &mdash; email or phone. They have your contact info, your
              preferred order size, and your state.
            </p>
            <p className="text-sm text-charcoal leading-relaxed">
              <strong>What they&rsquo;ll cover:</strong> current pricing for the
              cut you want, the next processing date, and how delivery or
              pickup works.
            </p>
            <p className="text-sm text-charcoal leading-relaxed">
              <strong>Pickup or delivery</strong> usually happens 2&ndash;4 weeks
              after you confirm &mdash; that&rsquo;s the time the rancher needs
              to process and age the beef properly.
            </p>
          </div>

          <Divider />

          <p className="text-sm text-saddle mt-8 leading-relaxed">
            Heads up: the call usually comes from the rancher&rsquo;s personal
            phone, not an 800 number. A {stateLabel} area code in the next few
            days &mdash; that&rsquo;s probably them.
          </p>

          <p className="text-xs text-saddle mt-8 leading-relaxed">
            No word within 48 hours? Reply to my last email. I&rsquo;ll make
            sure the connection happens.
          </p>

          <p className="text-xs text-saddle mt-2">&mdash; Ben</p>

          <div className="mt-8">
            <Link href="/member" className="text-sm underline text-charcoal hover:text-saddle transition-colors">
              Or open your member dashboard &rarr;
            </Link>
          </div>

          <MerchCTA />
        </div>
      </Container>
    </main>
  );
}
