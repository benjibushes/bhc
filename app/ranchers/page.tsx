import { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import Container from '../components/Container';
import Divider from '../components/Divider';
import { getActiveRancherPages } from '@/lib/airtable';
import { normalizeImageUrl } from '@/lib/imageUrl';

export const metadata: Metadata = {
  title: 'Our Ranchers',
  description: 'Browse BuyHalfCow\'s verified rancher partners. Grass-fed, pasture-raised beef — bought direct from the ranch.',
  openGraph: {
    title: 'Our Ranchers',
    description: 'Browse BuyHalfCow\'s verified rancher partners. Grass-fed, pasture-raised beef — bought direct from the ranch.',
    url: 'https://buyhalfcow.com/ranchers',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Our Ranchers',
    description: 'Browse BuyHalfCow\'s verified rancher partners. Grass-fed, pasture-raised beef — bought direct from the ranch.',
    images: ['/og-image.png'],
  },
};

// Revalidate every 10 minutes so new live pages appear without a redeploy
export const revalidate = 600;

export default async function RanchersPage() {
  let ranchers: any[] = [];

  try {
    const records = await getActiveRancherPages();
    ranchers = records as any[];
  } catch {
    // Show empty state rather than crashing
  }

  // Live counts from Airtable — honesty over vanity. Show real numbers,
  // even when small. 1 rancher in 1 state is more credible than "growing
  // network of partners across the country" without proof.
  const rancherCount = ranchers.length;
  const stateSet = new Set(
    ranchers
      .map((r: any) => (r['State'] || '').toString().trim())
      .filter(Boolean),
  );
  const stateCount = stateSet.size;
  const showStateFilter = rancherCount >= 10;
  const showEmptyShellState = rancherCount > 0 && rancherCount < 3;

  // Sort by state then name for stable display when filter is off.
  const sortedRanchers = [...ranchers].sort((a: any, b: any) => {
    const sA = (a['State'] || '').toString();
    const sB = (b['State'] || '').toString();
    if (sA !== sB) return sA.localeCompare(sB);
    const nA = (a['Ranch Name'] || a['Operator Name'] || '').toString();
    const nB = (b['Ranch Name'] || b['Operator Name'] || '').toString();
    return nA.localeCompare(nB);
  });

  return (
    <main className="min-h-screen py-20 md:py-24 bg-bone text-charcoal">
      <Container>
        <div className="max-w-5xl mx-auto space-y-12">

          {/* Header — lowercase per voice rules. Live counts only. */}
          <div className="text-center space-y-4">
            <p className="text-xs uppercase tracking-widest text-saddle">
              {rancherCount > 0
                ? `${rancherCount} verified ${rancherCount === 1 ? 'rancher' : 'ranchers'}${stateCount > 0 ? ` · ${stateCount} ${stateCount === 1 ? 'state' : 'states'}` : ''}`
                : 'verified ranchers'}
            </p>
            <h1 className="font-serif text-4xl md:text-5xl lowercase">
              our ranchers
            </h1>
            <Divider />
            <p className="text-base md:text-lg text-saddle max-w-2xl mx-auto leading-relaxed">
              Every rancher here has been approved by BuyHalfCow — vetted, USDA
              processing confirmed, real operation. Buy direct.
            </p>
          </div>

          {/* Rancher Grid */}
          {rancherCount === 0 ? (
            <div className="text-center py-20 md:py-24 space-y-5">
              <p className="text-base md:text-lg text-saddle max-w-md mx-auto leading-relaxed">
                More ranchers coming online weekly. See live partners on the map.
              </p>
              <a
                href="/map"
                className="inline-block px-6 py-3 bg-charcoal text-bone uppercase tracking-wide text-sm hover:bg-saddle transition-colors"
              >
                See the map →
              </a>
            </div>
          ) : (
            <>
              {/* State filter — only shows once we have enough density that
                  filtering matters. Below 10 ranchers, the full grid IS the
                  filter. Uses native <details>/anchor links so the page
                  remains a server component. */}
              {showStateFilter && (
                <details className="border border-dust bg-white">
                  <summary className="px-4 py-3 cursor-pointer text-sm uppercase tracking-widest text-saddle hover:text-charcoal">
                    Filter by state ({stateCount})
                  </summary>
                  <div className="px-4 pb-4 flex flex-wrap gap-2">
                    {[...stateSet].sort().map((s) => (
                      <a
                        key={s}
                        href={`#state-${s}`}
                        className="text-xs border border-dust px-2 py-0.5 text-saddle hover:border-charcoal hover:text-charcoal transition-colors"
                      >
                        {s}
                      </a>
                    ))}
                  </div>
                </details>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 md:gap-6">
                {sortedRanchers.map((r: any) => {
                  const slug = r['Slug'] || '';
                  const name = r['Ranch Name'] || r['Operator Name'] || 'Unknown Ranch';
                  const tagline = r['Tagline'] || '';
                  const logoUrl = normalizeImageUrl((r['Logo URL'] || '').toString());
                  const state = r['State'] || '';
                  const beefTypes = r['Beef Types'] || '';
                  const halfPrice = r['Half Price'] || null;

                  return (
                    <Link
                      key={r.id}
                      href={`/ranchers/${slug}`}
                      id={state ? `state-${state}` : undefined}
                      className="group block border border-dust bg-white hover:border-saddle transition-colors"
                    >
                      {/* Logo / Image area */}
                      <div className="h-28 sm:h-40 bg-bone flex items-center justify-center overflow-hidden">
                        {logoUrl ? (
                          <Image
                            src={logoUrl}
                            alt={`${name} logo`}
                            width={160}
                            height={100}
                            className="object-contain max-h-32 p-4"
                          />
                        ) : (
                          <span className="font-serif text-3xl text-dust">
                            {name.charAt(0)}
                          </span>
                        )}
                      </div>

                      {/* Card body */}
                      <div className="p-5 space-y-3">
                        <h2 className="font-serif text-xl group-hover:text-saddle transition-colors">
                          {name}
                        </h2>
                        {tagline && (
                          <p className="text-sm text-saddle leading-snug line-clamp-2">{tagline}</p>
                        )}
                        <div className="flex flex-wrap gap-2 pt-1">
                          {state && (
                            <span className="text-xs border border-dust px-2 py-0.5 text-saddle">
                              {state}
                            </span>
                          )}
                          {beefTypes && (
                            <span className="text-xs border border-dust px-2 py-0.5 text-saddle">
                              {beefTypes}
                            </span>
                          )}
                        </div>
                        {halfPrice && (
                          <p className="text-sm text-dust">
                            Half from{' '}
                            <span className="text-charcoal font-medium">
                              ${halfPrice.toLocaleString()}
                            </span>
                          </p>
                        )}
                        <p className="text-sm font-medium text-saddle group-hover:text-charcoal group-hover:underline mt-1">
                          View ranch →
                        </p>
                      </div>
                    </Link>
                  );
                })}
              </div>

              {/* Slim follow-up for low density — honest about scale. */}
              {showEmptyShellState && (
                <p className="text-center text-sm text-saddle max-w-md mx-auto">
                  More ranchers coming online weekly.{' '}
                  <Link href="/map" className="underline underline-offset-2 hover:text-charcoal">
                    See the map
                  </Link>{' '}
                  for unclaimed listings near you.
                </p>
              )}
            </>
          )}

          <Divider />

          {/* Footer CTA */}
          <div className="text-center space-y-4">
            <p className="text-saddle">Are you a rancher ready to partner with us?</p>
            <Link
              href="/partner"
              className="inline-block px-8 py-3 bg-charcoal text-bone text-sm tracking-wide uppercase hover:bg-saddle transition-colors"
            >
              Apply to partner
            </Link>
          </div>

        </div>
      </Container>
    </main>
  );
}
