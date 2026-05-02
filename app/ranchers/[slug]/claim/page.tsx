import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Container from '../../../components/Container';
import { getRancherOrProspectBySlug } from '@/lib/airtable';
import ClaimForm from './ClaimForm';

export const revalidate = 0;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const r: any = await getRancherOrProspectBySlug(slug);
  if (!r) return { title: 'Claim listing — BuyHalfCow' };
  const name = r['Ranch Name'] || r['Operator Name'] || 'this ranch';
  return {
    title: `Claim ${name} — BuyHalfCow`,
    description: `If you operate ${name}, claim your BuyHalfCow listing and start taking orders.`,
    robots: { index: false, follow: true },
  };
}

export default async function ClaimPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ confirmed?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const confirmed = sp.confirmed === '1';

  const rancher: any = await getRancherOrProspectBySlug(slug);
  if (!rancher) notFound();

  const name = (rancher['Ranch Name'] || rancher['Operator Name'] || 'this ranch') as string;
  const state = (rancher['State'] || '') as string;
  const isProspect = rancher['Verification Status'] === 'Prospect';
  const claimStatus = (rancher['Claim Status'] || 'unclaimed') as string;

  // Confirmed-from-magic-link state — separate page.
  if (confirmed) {
    return (
      <main className="min-h-screen bg-[#F4F1EC] text-[#0E0E0E]">
        <section className="py-20">
          <Container>
            <div className="max-w-xl mx-auto text-center space-y-6">
              <p className="text-xs uppercase tracking-widest text-[#6B4F3F]">
                Claim confirmed
              </p>
              <h1 className="font-[family-name:var(--font-playfair)] text-3xl md:text-4xl">
                Got it. Welcome aboard.
              </h1>
              <p className="text-[#0E0E0E]/80 leading-relaxed">
                {name} is now queued for the BuyHalfCow onboarding flow. I&rsquo;ll
                reach out personally within the next 24–48 hours to book a quick
                call, walk through the agreement, and get you set up to take
                orders.
              </p>
              <p className="text-sm text-[#6B4F3F]">
                Until then your listing stays as a prospect on the map — no
                pricing, no payments — so nobody mistakes it for an active
                partner. The moment you&rsquo;re live, the badge flips to verified
                and your page goes hot.
              </p>
              <p className="text-sm text-[#A7A29A]">— Ben</p>
              <div className="pt-4">
                <Link
                  href={`/ranchers/${slug}`}
                  className="inline-block px-8 py-3 border border-[#6B4F3F] text-[#6B4F3F] text-sm tracking-wide hover:bg-[#6B4F3F] hover:text-[#F4F1EC] transition-colors"
                >
                  Back to your listing
                </Link>
              </div>
            </div>
          </Container>
        </section>
      </main>
    );
  }

  // Already-verified rancher hit this page by mistake — redirect them.
  if (!isProspect) {
    return (
      <main className="min-h-screen bg-[#F4F1EC] text-[#0E0E0E]">
        <section className="py-20">
          <Container>
            <div className="max-w-xl mx-auto text-center space-y-6">
              <h1 className="font-[family-name:var(--font-playfair)] text-3xl">
                {name} is already verified.
              </h1>
              <p className="text-[#0E0E0E]/80">
                This listing is already live on BuyHalfCow. If you need to
                update something, log into your rancher dashboard or reach out
                directly.
              </p>
              <Link
                href={`/ranchers/${slug}`}
                className="inline-block px-8 py-3 border border-[#6B4F3F] text-[#6B4F3F] text-sm tracking-wide hover:bg-[#6B4F3F] hover:text-[#F4F1EC] transition-colors"
              >
                View listing
              </Link>
            </div>
          </Container>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#F4F1EC] text-[#0E0E0E]">
      <section className="py-16 border-b border-[#2A2A2A]/10">
        <Container>
          <div className="max-w-2xl mx-auto space-y-3">
            <p className="text-xs uppercase tracking-widest text-[#6B4F3F]">
              Claim listing
            </p>
            <h1 className="font-[family-name:var(--font-playfair)] text-3xl md:text-4xl">
              Are you {name}?
            </h1>
            <p className="text-[#0E0E0E]/80 leading-relaxed">
              Hey — Ben here. I built this page from public information so
              families looking for direct-to-consumer beef
              {state ? ` in ${state}` : ''} could find you. If you operate {name},
              fill this out and I&rsquo;ll send a magic link to confirm. Once you
              click it, I&rsquo;ll reach out to walk you through the onboarding —
              quick call, simple agreement, and your listing goes live.
            </p>
            <p className="text-sm text-[#6B4F3F]">
              No pressure. If you&rsquo;d rather not be on this list at all, use the
              <Link
                href={`/ranchers/${slug}/remove`}
                className="underline ml-1 hover:text-[#0E0E0E]"
              >
                remove me
              </Link>{' '}
              link instead.
            </p>
          </div>
        </Container>
      </section>

      <section className="py-12">
        <Container>
          <div className="max-w-md mx-auto">
            <ClaimForm slug={slug} ranchName={name} />
          </div>
        </Container>
      </section>

      <section className="pb-20">
        <Container>
          <div className="max-w-md mx-auto text-xs text-[#A7A29A] space-y-2">
            <p>
              Current claim status:{' '}
              <span className="text-[#6B4F3F]">{claimStatus}</span>
            </p>
            <p>
              Your contact info goes only to Ben (founder). We don&rsquo;t share
              it. By submitting you agree to receive the one-time magic link
              email.
            </p>
          </div>
        </Container>
      </section>
    </main>
  );
}
