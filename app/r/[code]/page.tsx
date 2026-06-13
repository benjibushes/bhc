// app/r/[code]/page.tsx
//
// Affiliate landing page (2026-06-06).
//
// Single URL shape for an affiliate to share: buyhalfcow.com/r/<code>
// Server-side validates the code, then renders a self-select picker so
// the lead funnels themselves into the right downstream form:
//   - Beef Buyer    → /access?ref=<code>      → 5-step quiz + match
//   - Rancher       → /apply?ref=<code>       → /apply discovery + wizard
//   - Brand Partner → /brand-partners?ref=<code>
//   - Wholesale     → /wholesale?ref=<code>
//
// Each downstream form already reads ?ref and stamps the canonical
// `Referred By` field on the new record at signup time — no new write
// logic here. This page is pure routing + attribution-presentation.
//
// Click tracking fires client-side on mount via the existing
// /api/affiliates/track-click endpoint so the affiliate's stats reflect
// every landing-page visit even when the visitor abandons before signup.
//
// 404 for invalid / inactive codes so a bad URL doesn't silently send the
// visitor down the unattributed funnel.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import Container from '@/app/components/Container';
import { findAffiliateByCode, normalizeAffiliateCode } from '@/lib/affiliates';
import { Suspense } from 'react';

export const dynamic = 'force-dynamic';

// Client-side ping. Fires on mount so we capture every landing-page view.
// Lives in its own component so the parent server component stays static.
function TrackClickScript({ code }: { code: string }) {
  const safe = code.replace(/[^a-z0-9_-]/gi, '').slice(0, 64);
  // Inline tag — small JS, no extra bundle. Fires-and-forgets so a click-
  // tracking error never blocks the landing render.
  const js = `(function(){try{fetch('/api/affiliates/track-click?code=${safe}').catch(function(){});}catch(e){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}

export default async function AffiliateLandingPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const normalized = normalizeAffiliateCode(code);
  if (!normalized) notFound();

  const affiliate = await findAffiliateByCode(normalized);
  if (!affiliate) notFound();

  const status = String(affiliate['Status'] || '').toLowerCase();
  if (status !== 'active') notFound();

  const fullName = String(affiliate['Full Name'] || affiliate['Name'] || '').trim();
  const firstName = fullName.split(' ')[0] || fullName || 'A friend';
  const refQs = `?ref=${encodeURIComponent(normalized)}`;

  // Segment cards — drives downstream form selection. Each card target is
  // ALREADY wired to read ?ref + stamp `Referred By` on signup.
  const cards = [
    {
      key: 'beef-buyer',
      title: 'Get a half cow for my family',
      sub: 'Direct from a rancher near you. Local pickup, delivery, or cold-chain ship. We match you in days, not months.',
      href: `/access${refQs}`,
      cta: 'Start as a buyer',
    },
    {
      key: 'rancher',
      title: 'I raise cattle and want to sell',
      sub: 'List your operation, set capacity, get qualified buyers. 5-min onboarding wizard + Stripe Connect.',
      href: `/apply${refQs}`,
      cta: 'Start as a rancher',
    },
    {
      key: 'brand-partner',
      title: 'I run a brand for ranchers',
      sub: 'Tallow, soap, jerky, leather, knives — get listed on every rancher’s landing page. Subscription tier.',
      href: `/brand-partners${refQs}`,
      cta: 'Start as a brand',
    },
    {
      key: 'wholesale',
      title: 'I buy beef for my restaurant or store',
      sub: 'Custom wholesale pricing on quarters, halves, whole carcasses. Direct rancher relationships.',
      href: `/wholesale${refQs}`,
      cta: 'Start as wholesale',
    },
  ] as const;

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <Suspense fallback={null}>
        <TrackClickScript code={normalized} />
      </Suspense>

      <Container>
        <div className="max-w-3xl mx-auto py-12 md:py-20 px-4 md:px-6">
          {/* Affiliate intro */}
          <p className="text-xs uppercase tracking-widest text-saddle mb-3">
            {firstName} sent you to BuyHalfCow
          </p>
          <h1 className="font-serif text-3xl md:text-5xl leading-tight mb-4">
            What brings you here?
          </h1>
          <p className="text-saddle mb-8 md:mb-12 leading-relaxed">
            Pick the path that fits. We match buyers to ranchers direct &mdash; no
            middleman markup, no warehouse beef. {firstName}&rsquo;s referral keeps
            you on the inside track.
          </p>

          {/* Segment cards */}
          <div className="space-y-4 md:space-y-5">
            {cards.map((card) => (
              <Link
                key={card.key}
                href={card.href}
                className="block group border border-dust bg-white p-5 md:p-6 hover:border-charcoal transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <h2 className="font-serif text-xl md:text-2xl mb-2 group-hover:text-saddle transition-colors">
                      {card.title}
                    </h2>
                    <p className="text-sm md:text-base text-saddle leading-relaxed">
                      {card.sub}
                    </p>
                  </div>
                  <span className="text-2xl text-saddle group-hover:translate-x-1 transition-transform">
                    &rarr;
                  </span>
                </div>
                <p className="mt-3 text-xs uppercase tracking-widest text-charcoal font-semibold">
                  {card.cta} &rarr;
                </p>
              </Link>
            ))}
          </div>

          {/* Operator note */}
          <p className="text-xs text-saddle mt-10 leading-relaxed">
            Already have an account? <Link href="/member" className="underline">Sign in to your buyer dashboard</Link> or{' '}
            <Link href="/rancher" className="underline">your rancher dashboard</Link>.
          </p>
        </div>
      </Container>
    </main>
  );
}
