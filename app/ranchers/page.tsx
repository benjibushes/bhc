import { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import Container from '../components/Container';
import Divider from '../components/Divider';
import { getActiveRancherPages } from '@/lib/airtable';

export const metadata: Metadata = {
  title: 'Our Ranchers',
  description: 'Browse BuyHalfCow\'s verified rancher partners. Grass-fed, pasture-raised beef — bought direct from the ranch.',
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
    <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
      <Container>
        <div className="max-w-5xl mx-auto space-y-12">

          {/* Header */}
          <div className="text-center space-y-4">
            <p className="text-sm uppercase tracking-widest text-[#6B4F3F]">Verified Partners</p>
            <h1 className="font-[family-name:var(--font-playfair)] text-4xl md:text-5xl">
              Our Ranchers
            </h1>
            <Divider />
            <p className="text-lg text-[#6B4F3F] max-w-2xl mx-auto leading-relaxed">
              Every rancher on this page has been personally vetted by BuyHalfCow.
              You're not buying from an algorithm — you're buying from a real operation with a real story.
            </p>
          </div>

          {/* Rancher Grid */}
          {ranchers.length === 0 ? (
            <div className="text-center py-24 text-[#A7A29A]">
              <p className="text-xl">Rancher pages coming soon.</p>
              <p className="mt-2 text-base">
                <Link href="/access" className="underline hover:text-[#0E0E0E]">Apply for access</Link> to get matched with a rancher in your area.
              </p>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {ranchers.map((r: any) => {
                const slug = r['Slug'] || '';
                const name = r['Ranch Name'] || r['Operator Name'] || 'Unknown Ranch';
                const tagline = r['Tagline'] || '';
                const logoUrl = r['Logo URL'] || '';
                const state = r['State'] || '';
                const beefTypes = r['Beef Types'] || '';
                const halfPrice = r['Half Price'] || null;

                return (
                  <Link
                    key={r.id}
                    href={`/ranchers/${slug}`}
                    className="group block border border-[#A7A29A] bg-white hover:border-[#6B4F3F] transition-colors"
                  >
                    {/* Logo / Image area */}
                    <div className="h-40 bg-[#F4F1EC] flex items-center justify-center overflow-hidden">
                      {logoUrl ? (
                        <Image
                          src={logoUrl}
                          alt={`${name} logo`}
                          width={160}
                          height={100}
                          className="object-contain max-h-32 p-4"
                          unoptimized
                        />
                      ) : (
                        <span className="font-[family-name:var(--font-playfair)] text-3xl text-[#A7A29A]">
                          {name.charAt(0)}
                        </span>
                      )}
                    </div>

                    {/* Card body */}
                    <div className="p-5 space-y-3">
                      <h2 className="font-[family-name:var(--font-playfair)] text-xl group-hover:text-[#6B4F3F] transition-colors">
                        {name}
                      </h2>
                      {tagline && (
                        <p className="text-sm text-[#6B4F3F] leading-snug">{tagline}</p>
                      )}
                      <div className="flex flex-wrap gap-2 pt-1">
                        {state && (
                          <span className="text-xs border border-[#A7A29A] px-2 py-0.5 text-[#6B4F3F]">
                            {state}
                          </span>
                        )}
                        {beefTypes && (
                          <span className="text-xs border border-[#A7A29A] px-2 py-0.5 text-[#6B4F3F]">
                            {beefTypes}
                          </span>
                        )}
                      </div>
                      {halfPrice && (
                        <p className="text-sm text-[#A7A29A]">
                          Half cow from <span className="text-[#0E0E0E] font-medium">${halfPrice.toLocaleString()}</span>
                        </p>
                      )}
                      <p className="text-sm font-medium text-[#8C2F2F] group-hover:underline mt-1">
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
            <p className="text-[#6B4F3F]">Are you a rancher ready to partner with us?</p>
            <Link
              href="/partner"
              className="inline-block px-8 py-3 bg-[#0E0E0E] text-[#F4F1EC] text-sm tracking-wide hover:bg-[#6B4F3F] transition-colors"
            >
              Apply to Partner
            </Link>
          </div>

        </div>
      </Container>
    </main>
  );
}
