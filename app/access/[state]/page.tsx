import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import Container from '../../components/Container';
import Button from '../../components/Button';
import Divider from '../../components/Divider';
import base, { TABLES, escapeAirtableValue } from '@/lib/airtable';
import { US_STATES, stateName, normalizeState } from '@/lib/states';
import { normalizeImageUrl } from '@/lib/imageUrl';

// Revalidate hourly — rancher counts + new ranchers come online weekly,
// but SSG keeps these pages fast under paid-ad load.
export const revalidate = 3600;

interface Props {
  params: Promise<{ state: string }>;
}

interface RancherCard {
  id: string;
  slug: string;
  ranchName: string;
  operatorName: string;
  city: string;
  logoUrl: string;
  tagline: string;
  certifications: string;
}

// Find a state by URL slug (lowercase 2-letter code). Returns full name
// for hero copy, or null if the slug isn't a real US state.
function resolveState(slug: string): { code: string; name: string } | null {
  const code = normalizeState(slug);
  if (!code) return null;
  const found = US_STATES.find((s) => s.code === code);
  return found ? { code: found.code, name: found.name } : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { state } = await params;
  const resolved = resolveState(state);
  if (!resolved) {
    return {
      title: 'BuyHalfCow',
      description: 'Direct ranch beef. No middlemen.',
    };
  }

  const { name } = resolved;
  const lowerSlug = state.toLowerCase();
  const title = `Buy half-cow direct from ${name} ranchers — BuyHalfCow`;
  const description = `Verified ${name} ranchers, vetted by BuyHalfCow. 90-second match. No marketplace markup. Direct ranch beef from real ${name} operations.`;
  const url = `https://www.buyhalfcow.com/access/${lowerSlug}`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url,
      images: ['/og-image.png'],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: ['/og-image.png'],
    },
    alternates: {
      canonical: url,
    },
  };
}

// Fetch ranchers + closed-deal count for one state.
// The `{State}` field in Airtable is unnormalized (some records have the
// 2-letter code, some have the full name). Filter on both to be safe.
async function fetchStateData(stateCode: string, stateName: string): Promise<{
  ranchers: RancherCard[];
  totalClosedDeals: number;
}> {
  const safeCode = escapeAirtableValue(stateCode);
  const safeName = escapeAirtableValue(stateName);

  let ranchers: RancherCard[] = [];
  try {
    const records = await base(TABLES.RANCHERS)
      .select({
        filterByFormula:
          `AND({Page Live} = 1, NOT({Public Map Hidden} = 1), ` +
          `{Verification Status} != "Removed", ` +
          `OR(UPPER({State}) = "${safeCode}", UPPER({State}) = "${safeName.toUpperCase()}"))`,
        maxRecords: 50,
      })
      .all();

    ranchers = records.map((r) => ({
      id: r.id,
      slug: String(r.fields['Slug'] || ''),
      ranchName: String(r.fields['Ranch Name'] || r.fields['Operator Name'] || 'Ranch'),
      operatorName: String(r.fields['Operator Name'] || ''),
      city: String(r.fields['City'] || ''),
      logoUrl: normalizeImageUrl(String(r.fields['Logo URL'] || '')),
      tagline: String(r.fields['Tagline'] || ''),
      certifications: String(r.fields['Certifications'] || ''),
    }));
  } catch (e) {
    console.error(`[access/[state]] fetchStateData ranchers failed for ${stateCode}:`, e);
  }

  // Best-effort closed-deal count. Soft-fail so a missing field or table
  // shape change doesn't break the whole page.
  let totalClosedDeals = 0;
  try {
    const closedRecs = await base(TABLES.REFERRALS)
      .select({
        filterByFormula:
          `AND({Status} = "Closed Won", ` +
          `OR(UPPER({State}) = "${safeCode}", UPPER({State}) = "${safeName.toUpperCase()}"))`,
        fields: ['Status'],
        maxRecords: 500,
      })
      .all();
    totalClosedDeals = closedRecs.length;
  } catch {
    // best-effort — no logging, this is decorative
  }

  return { ranchers, totalClosedDeals };
}

export default async function AccessStatePage({ params }: Props) {
  const { state } = await params;
  const resolved = resolveState(state);
  if (!resolved) notFound();

  const { code: stateCode, name: stateNameFull } = resolved;
  const { ranchers, totalClosedDeals } = await fetchStateData(stateCode, stateNameFull);
  const hasRanchers = ranchers.length > 0;
  const lowerSlug = state.toLowerCase();

  // JSON-LD for state-localized landing — helps Google understand this
  // page is about beef sourcing in a specific geographic region.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: `Buy half-cow direct from ${stateNameFull} ranchers`,
    description: `Verified ${stateNameFull} ranchers. Direct ranch beef. No middlemen.`,
    url: `https://www.buyhalfcow.com/access/${lowerSlug}`,
    about: {
      '@type': 'Place',
      name: stateNameFull,
      address: {
        '@type': 'PostalAddress',
        addressRegion: stateCode,
        addressCountry: 'US',
      },
    },
    publisher: {
      '@type': 'Organization',
      name: 'BuyHalfCow',
      url: 'https://www.buyhalfcow.com',
    },
  };

  return (
    <main className="min-h-screen bg-[#F4F1EC] text-[#0E0E0E] py-16 md:py-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Container>
        {/* Hero */}
        <div className="max-w-3xl mx-auto text-center space-y-6 mb-16">
          <p className="text-sm uppercase tracking-widest text-[#6B4F3F]">
            {stateNameFull} · Verified Ranchers
          </p>
          <h1 className="font-[family-name:var(--font-playfair)] text-4xl md:text-5xl leading-tight">
            buy half-cow direct from {stateNameFull} ranchers
          </h1>
          <Divider />
          <p className="text-[#6B4F3F] text-lg leading-relaxed">
            {hasRanchers ? (
              <>
                {ranchers.length} verified {ranchers.length === 1 ? 'rancher' : 'ranchers'} in {stateNameFull}.{' '}
                {totalClosedDeals > 0
                  ? `${totalClosedDeals} ${stateNameFull} families fed direct this year.`
                  : '90-second quiz match — no marketplace markup, no middlemen.'}
              </>
            ) : (
              <>
                {stateNameFull} ranchers are joining BuyHalfCow weekly. Get on the waitlist —
                we'll match you the moment a verified rancher comes online in {stateNameFull}.
              </>
            )}
          </p>
          <div className="pt-2">
            <Button href={`/access?state=${stateCode}`} size="lg">
              {hasRanchers ? 'find my rancher →' : `waitlist me for ${stateNameFull} →`}
            </Button>
          </div>
        </div>

        {/* Rancher list (only if any) */}
        {hasRanchers && (
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-10">
              <h2 className="font-[family-name:var(--font-playfair)] text-3xl md:text-4xl">
                verified ranchers in {stateNameFull}
              </h2>
              <p className="text-[#6B4F3F] mt-3 max-w-2xl mx-auto">
                Every operation below has been personally vetted. Click through to see
                their full story, beef types, and pricing.
              </p>
            </div>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {ranchers.map((r) => (
                <Link
                  key={r.id}
                  href={`/ranchers/${r.slug}`}
                  className="group block border border-[#A7A29A] bg-white hover:border-[#6B4F3F] transition-colors"
                >
                  <div className="h-40 bg-[#F4F1EC] flex items-center justify-center overflow-hidden">
                    {r.logoUrl ? (
                      <Image
                        src={r.logoUrl}
                        alt={`${r.ranchName} logo`}
                        width={160}
                        height={100}
                        className="object-contain max-h-32 p-4"
                        unoptimized
                      />
                    ) : (
                      <span className="font-[family-name:var(--font-playfair)] text-3xl text-[#A7A29A]">
                        {r.ranchName.charAt(0)}
                      </span>
                    )}
                  </div>
                  <div className="p-5 space-y-2">
                    <h3 className="font-[family-name:var(--font-playfair)] text-xl group-hover:text-[#6B4F3F] transition-colors">
                      {r.ranchName}
                    </h3>
                    {r.tagline && (
                      <p className="text-sm text-[#6B4F3F] line-clamp-2">{r.tagline}</p>
                    )}
                    <p className="text-xs uppercase tracking-widest text-[#A7A29A]">
                      {r.city ? `${r.city}, ${stateCode}` : stateNameFull}
                    </p>
                    {r.certifications && (
                      <p className="text-xs uppercase tracking-widest text-[#A7A29A] pt-1">
                        {r.certifications}
                      </p>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Secondary CTA */}
        <div className="max-w-2xl mx-auto text-center mt-20 space-y-4">
          <p className="text-[#6B4F3F]">
            Ready to skip the grocery aisle? The 90-second match takes care of the rest.
          </p>
          <Button href={`/access?state=${stateCode}`} variant="secondary">
            start the quiz →
          </Button>
        </div>
      </Container>
    </main>
  );
}

// Generate static params for all 50 states + DC. Lowercase URL slugs.
export async function generateStaticParams() {
  return US_STATES.map((s) => ({ state: s.code.toLowerCase() }));
}
