// /book/[refId] — On-site booking keystone (iframe interim)
//
// Every booking link in email/SMS now lands HERE instead of a raw cal.com URL,
// so the buyer never leaves buyhalfcow.com. The Cal embed is prefilled with the
// buyer's name + email (resolved from the Referral → Consumer) and
// metadata[referralId] is set so the existing /api/webhooks/cal ties the booking
// back to the referral record.
//
// The page degrades gracefully: if the referral isn't found (bad/expired link),
// the booker still renders with no prefill — booking is always the goal.
//
// TODO (later enhancement): accept an optional `rancherId` search param or
// resolve the Rancher from the referral and pass their calLink so tier_v2
// ranchers with their own Cal event can be booked here too. For now, all
// /book links route to the operator sales call via getOperatorBookingUrl('sales').

import { getRecordById, TABLES } from '@/lib/airtable';
import { getOperatorBookingUrl } from '@/lib/calBooking';
import CalInlineBooker from '@/app/qualify/[consumerId]/CalInlineBooker';

interface PageProps {
  params: Promise<{ refId: string }>;
}

export default async function BookPage({ params }: PageProps) {
  const { refId } = await params;

  // --- Resolve buyer name/email from referral (never throws) ---
  let buyerName = '';
  let buyerEmail = '';

  try {
    const referral = (await getRecordById(TABLES.REFERRALS, refId)) as any;
    const consumerId = referral?.['Buyer']?.[0];
    if (consumerId) {
      const consumer = (await getRecordById(TABLES.CONSUMERS, consumerId)) as any;
      buyerName = String(consumer?.['Full Name'] || '');
      buyerEmail = String(consumer?.['Email'] || '');
    }
  } catch {
    // Referral not found or fetch failed — render the booking page with no
    // prefill. We never hard-fail; booking is always the goal.
  }

  // --- Resolve the booking URL (never-throw resolver) ---
  // Uses the operator sales call for all /book links today.
  // TODO: slot rancher-specific booking here (check referral['Rancher'] → calLink).
  const bookingUrl = await getOperatorBookingUrl('sales');

  // Strip the cal.com origin to get the embed-ready path ('username/slug').
  // The resolver returns either a full https://cal.com/... URL or a
  // /contact fallback. CalInlineBooker expects 'username/slug' via operatorCalLink.
  const operatorCalLink = bookingUrl.replace(/^https?:\/\/cal\.com\//, '').replace(/^https?:\/\/app\.cal\.com\//, '');

  return (
    <main className="min-h-screen bg-[#FAF7F2] flex flex-col items-center px-4 py-10 md:py-16">
      {/* On-brand header — serif, saddle accent, no nav/footer (ChromeGate seals this route) */}
      <header className="w-full max-w-xl mb-8 text-center">
        <p className="text-xs font-mono tracking-widest uppercase text-[#92632F] mb-3">
          BuyHalfCow.com
        </p>
        <h1 className="font-serif text-3xl md:text-4xl text-[#0E0E0E] leading-tight mb-3">
          Book your call
        </h1>
        <p className="text-sm text-[#5C5C5C] leading-relaxed max-w-sm mx-auto">
          Pick a time that works for you. We&apos;ll cover your order, the ranch, and
          delivery — usually 20 minutes.
        </p>
        {buyerName && (
          <p className="mt-3 text-xs text-[#92632F] font-mono">
            Reserved for {buyerName}
          </p>
        )}
      </header>

      {/* Cal inline embed — prefilled, webhook-tied */}
      <div className="w-full max-w-2xl">
        <CalInlineBooker
          operatorCalLink={operatorCalLink}
          name={buyerName || undefined}
          email={buyerEmail || undefined}
          referralId={refId}
        />
      </div>

      <footer className="mt-10 text-xs text-[#9E9E9E] text-center">
        Questions?{' '}
        <a href="mailto:ben@buyhalfcow.com" className="underline hover:text-[#92632F]">
          ben@buyhalfcow.com
        </a>
      </footer>
    </main>
  );
}
