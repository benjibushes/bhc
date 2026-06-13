import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Container from '../../../components/Container';
import { getRancherOrProspectBySlug } from '@/lib/airtable';
import RemoveForm from './RemoveForm';

export const revalidate = 0;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const r: any = await getRancherOrProspectBySlug(slug);
  if (!r) return { title: 'Remove listing — BuyHalfCow' };
  const name = r['Ranch Name'] || r['Operator Name'] || 'this ranch';
  return {
    title: `Remove ${name} from BuyHalfCow`,
    description: `Request removal of the ${name} listing from BuyHalfCow's discover map.`,
    robots: { index: false, follow: false },
  };
}

export default async function RemovePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const rancher: any = await getRancherOrProspectBySlug(slug);
  if (!rancher) notFound();

  const name = (rancher['Ranch Name'] || rancher['Operator Name'] || 'this ranch') as string;
  const state = (rancher['State'] || '') as string;

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <section className="py-16 border-b border-divider/10">
        <Container>
          <div className="max-w-2xl mx-auto space-y-3">
            <p className="text-xs uppercase tracking-widest text-saddle">
              Remove listing
            </p>
            <h1 className="font-serif text-3xl md:text-4xl">
              Remove {name}{state ? ` (${state})` : ''}
            </h1>
            <p className="text-charcoal/80 leading-relaxed">
              We built this listing from public information about
              direct-to-consumer ranchers. If you don&rsquo;t want to be on this
              list, hit the button below and the listing comes off the map and
              stops being indexed within minutes.
            </p>
            <p className="text-sm text-saddle">
              No verification needed — we honor opt-outs immediately. Ben gets
              an alert and will reach out personally if you want to talk.
            </p>
          </div>
        </Container>
      </section>

      <section className="py-12">
        <Container>
          <div className="max-w-md mx-auto">
            <RemoveForm slug={slug} ranchName={name} />
          </div>
        </Container>
      </section>

      <section className="pb-20">
        <Container>
          <div className="max-w-md mx-auto text-xs text-dust space-y-2">
            <p>
              Changed your mind? The{' '}
              <Link
                href={`/ranchers/${slug}/claim`}
                className="underline hover:text-charcoal"
              >
                claim flow
              </Link>{' '}
              is still here if you want to take over the listing instead.
            </p>
          </div>
        </Container>
      </section>
    </main>
  );
}
