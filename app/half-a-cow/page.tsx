// /half-a-cow — index for the programmatic state SEO pages ("half a cow
// near me"). Fully static: no Airtable, just the 50 state links + the
// honest cost math teaser. Interlinks every /half-a-cow/[state] page so
// crawlers discover the whole set from one indexable hub.

import type { Metadata } from 'next';
import Link from 'next/link';
import Container from '../components/Container';
import Button from '../components/Button';
import Divider from '../components/Divider';
import { jsonLdSafe } from '@/lib/jsonLdSafe';
import { SEO_STATES, typicalShareRanges, fmtRange } from '@/lib/stateSeo';

const BASE_URL = 'https://www.buyhalfcow.com';

const ranges = typicalShareRanges();

export const metadata: Metadata = {
  title: 'Buy Half a Cow Near You — Ranch Beef Shares in All 50 States',
  description:
    `Buy half a cow direct from a verified family ranch near you. Typical half-beef shares run ${fmtRange(ranges.half)} all-in (~$8–11/lb hanging weight). Pick your state, take the 90-second quiz, reserve with a ${ranges.depositPercent}% refundable deposit.`,
  robots: { index: true, follow: true },
  alternates: { canonical: `${BASE_URL}/half-a-cow` },
  openGraph: {
    title: 'Buy Half a Cow Near You',
    description: 'Direct ranch beef shares, state by state. No middlemen, no markup.',
    url: `${BASE_URL}/half-a-cow`,
    images: ['/og-image.png'],
  },
};

const breadcrumbJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: BASE_URL },
    { '@type': 'ListItem', position: 2, name: 'Half a Cow Near You', item: `${BASE_URL}/half-a-cow` },
  ],
};

export default function HalfACowIndexPage() {
  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdSafe(breadcrumbJsonLd) }}
      />

      {/* ── HERO ── */}
      <section className="pt-8 pb-12 md:py-24">
        <Container>
          <div className="max-w-3xl mx-auto text-center space-y-5 md:space-y-6">
            <p className="text-xs uppercase tracking-widest text-saddle font-semibold">
              beef shares · direct from the ranch
            </p>
            <h1 className="font-serif text-4xl md:text-6xl leading-tight lowercase">
              buy half a cow near you
            </h1>
            <Divider />
            <p className="text-lg md:text-xl max-w-2xl mx-auto leading-snug md:leading-relaxed text-saddle">
              A half beef from a verified family ranch typically runs{' '}
              {fmtRange(ranges.half)} all-in — about $8&ndash;11 per pound hanging
              weight, against $13&ndash;17/lb from boxed-delivery services. Pick your
              state, or let the 90-second quiz match you straight away.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
              <Button href="/access" size="lg">
                take the 90-second quiz →
              </Button>
              <Button href="/guide" variant="secondary" size="lg">
                read the honest math
              </Button>
            </div>
          </div>
        </Container>
      </section>

      {/* ── STATE GRID ── */}
      <section className="pb-16 md:pb-24">
        <Container>
          <div className="max-w-4xl mx-auto space-y-8">
            <h2 className="font-serif text-3xl md:text-4xl lowercase text-center">
              pick your state
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {SEO_STATES.map((s) => (
                <Link
                  key={s.code}
                  href={`/half-a-cow/${s.slug}`}
                  className="block border border-dust bg-bone-warm px-4 py-3 text-[14.5px] text-charcoal hover:border-saddle hover:text-saddle transition-colors rounded-sm"
                >
                  {s.name}
                </Link>
              ))}
            </div>
            <p className="text-center text-[13.5px] text-saddle">
              prefer to browse?{' '}
              <Link href="/map" className="underline hover:text-charcoal transition-colors">
                see every verified ranch on the map →
              </Link>
            </p>
          </div>
        </Container>
      </section>
    </main>
  );
}
