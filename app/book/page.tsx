// /book — Generic on-site operator sales call booking (no referral context).
//
// Destination for all generic "Book a call" CTAs in email/drip (CALENDLY_LINK
// env var now resolves here via ${SITE_URL}/book). Buyer stays on
// buyhalfcow.com — no redirect to cal.com. Sealed by ChromeGate so only
// authed members reach the embed.
//
// No buyer prefill (no referral/consumer to resolve), no referralId metadata.
// The Cal webhook still fires on BOOKING_CREATED; without referralId it falls
// through to email-match logic.

import { getOperatorBookingUrl } from '@/lib/calBooking';
import CalInlineBooker from '@/app/qualify/[consumerId]/CalInlineBooker';

export default async function BookGenericPage({
  searchParams,
}: {
  searchParams: Promise<{ purpose?: string }>;
}) {
  // ?purpose=rancher routes this on-site keystone to the rancher-onboarding
  // event (used by /apply, /partner, the setup wizard); default is the buyer
  // sales call. Both resolve a LIVE Cal event server-side — never a dead slug.
  const { purpose: rawPurpose } = await searchParams;
  const purpose = rawPurpose === 'rancher' ? 'rancher' : 'sales';
  const bookingUrl = await getOperatorBookingUrl(purpose);
  // Strip origin to get embed-ready 'username/slug'.
  const operatorCalLink = bookingUrl
    .replace(/^https?:\/\/cal\.com\//, '')
    .replace(/^https?:\/\/app\.cal\.com\//, '');

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
          delivery — usually 15–20 minutes.
        </p>
      </header>

      {/* Operator sales call iframe — battle-tested embed, always works */}
      <div className="w-full max-w-2xl">
        <CalInlineBooker operatorCalLink={operatorCalLink} />
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
