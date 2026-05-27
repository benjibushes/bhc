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

  return (
    <main className="min-h-screen py-24 bg-bone text-charcoal">
      <Container>
        <div className="max-w-5xl mx-auto space-y-12">

          {/* Header */}
          <div className="text-center space-y-4">
            <p className="text-sm uppercase tracking-widest text-saddle">Verified Partners</p>
            <h1 className="font-serif text-4xl md:text-5xl">
              Our Ranchers
            </h1>
            <Divider />
            <p className="text-lg text-saddle max-w-2xl mx-auto leading-relaxed">
              Every rancher on this page has been personally vetted by BuyHalfCow.
              You're not buying from an algorithm — you're buying from a real operation with a real story.
            </p>
          </div>

          {/* Rancher Grid */}
          {ranchers.length === 0 ? (
            <div className="text-center py-24 space-y-4">
              <p className="text-lg text-saddle">
                Rancher pages are coming online weekly. See live partners on the map.
              </p>
              <a
                href="/map"
                className="inline-block px-6 py-3 bg-charcoal text-bone uppercase tracking-wide text-sm hover:bg-saddle transition-colors"
              >
                See the map →
              </a>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {ranchers.map((r: any) => {
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
                    className="group block border border-dust bg-white hover:border-saddle transition-colors"
                  >
                    {/* Logo / Image area */}
                    <div className="h-40 bg-bone flex items-center justify-center overflow-hidden">
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
                        <p className="text-sm text-saddle leading-snug">{tagline}</p>
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
                          Half cow from <span className="text-charcoal font-medium">${halfPrice.toLocaleString()}</span>
                        </p>
                      )}
                      <p className="text-sm font-medium text-rust group-hover:underline mt-1">
                        View Ranch →
                      </p>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}

          <Divider />

          {/* Footer CTA */}
          <div className="text-center space-y-4">
            <p className="text-saddle">Are you a rancher ready to partner with us?</p>
            <Link
              href="/partner"
              className="inline-block px-8 py-3 bg-charcoal text-bone text-sm tracking-wide hover:bg-saddle transition-colors"
            >
              Apply to Partner
            </Link>
          </div>

        </div>
      </Container>
    </main>
  );
}
