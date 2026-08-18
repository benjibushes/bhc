import { redirect } from 'next/navigation';
import { getRancherOrProspectBySlug } from '@/lib/airtable';
import { isBrokerRancher } from '@/lib/brokerRail';
import ContactPageClient from './ContactPageClient';

// BROKER RAIL (comms containment wave 0-A, 2026-08-18). A represented
// (broker-rail) ranch must never render a contact form: on that rail the
// deposit IS BHC's entire fee, and buyer↔ranch contact before the deposit is
// the direct-transaction leak. The ranch page already hides its Contact CTA
// for broker self-serve, but this URL is one guess away — and it used to
// dead-end in a false "Rancher Not Found" (the client fetches
// /api/public/ranchers/[slug], whose lookup excludes broker rows). Gate the
// RENDER server-side: broker slug → the ranch's own reserve section, where a
// deposit can actually be taken. The POST handler carries its own refusal —
// this is the door, that is the lock.
//
// Fail direction: an unreadable slug renders the client page unchanged (its
// own fetch shows the existing not-found state) — the money guard on the
// send path is server-side in the contact API, not here.
export const dynamic = 'force-dynamic';

export default async function RancherContactPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const rancher: any = await getRancherOrProspectBySlug(slug).catch(() => null);
  if (rancher && isBrokerRancher(rancher)) {
    redirect(`/ranchers/${slug}#reserve`);
  }
  return <ContactPageClient />;
}
