// /book/[refId] — On-site booking keystone (native atoms + iframe fallback)
//
// Every booking link in email/SMS now lands HERE instead of a raw cal.com URL,
// so the buyer never leaves buyhalfcow.com. The Cal embed is prefilled with the
// buyer's name + email (resolved from the Referral → Consumer) and
// metadata[referralId] is set so the existing /api/webhooks/cal ties the booking
// back to the referral record.
//
// BOOKER STRATEGY (2026-06-19):
//   Two paths, selected by the CAL_NATIVE_BOOKER env var (default OFF):
//
//   A) CAL_NATIVE_BOOKER=true → <BookerNative> (@calcom/atoms Booker)
//      Renders Cal's booking UI natively via atoms. No iframe. Buyer stays
//      100% on buyhalfcow.com DOM. An ErrorBoundary inside BookerNative
//      catches any atoms failure and calls `onError`; the client component
//      NativeWithFallback then switches to <CalInlineBooker>.
//
//   B) CAL_NATIVE_BOOKER=false (or unset) → <CalInlineBooker> iframe
//      The existing battle-tested inline embed. Booking ALWAYS works.
//
// Research verdict: @calcom/atoms Booker hits /atoms/event-types/{slug}/public
// with x-cal-client-id header. The Cal platform API /public endpoint should
// support any public cal.com account (not just managed users) based on the
// prop types (plain username, no managed-user restriction) and docs examples.
// HOWEVER, the platform plan is noted maintenance-only and local testing isn't
// possible without the NEXT_PUBLIC_CAL_OAUTH_CLIENT_ID env var, so the flag
// defaults to OFF until the owner confirms atoms resolve ben-beauchman-1itnsg.
//
// metadata.referralId round-trip: BookerNative passes `metadata={{ referralId }}`
// → Cal stores it on the booking → /api/webhooks/cal receives it in
// payload.booking.metadata.referralId (same path as the iframe flow's
// metadata[referralId] config key).

import { getRecordById, TABLES } from '@/lib/airtable';
import { getOperatorBookingUrl } from '@/lib/calBooking';
import CalInlineBooker from '@/app/qualify/[consumerId]/CalInlineBooker';
import NativeWithFallback from './NativeWithFallback';

interface PageProps {
  params: Promise<{ refId: string }>;
}

// CAL_NATIVE_BOOKER is a server-only env var (no NEXT_PUBLIC_ prefix):
// keeps the feature flag decision server-side, away from the client bundle.
const NATIVE_BOOKER_ENABLED = process.env.CAL_NATIVE_BOOKER === 'true';

// Operator Cal credentials — resolved here so BookerNative never has to
// call the Cal API itself; env vars with documented fallbacks.
const CAL_OPERATOR_USERNAME = process.env.CAL_OPERATOR_USERNAME || 'ben-beauchman-1itnsg';
const CAL_OPERATOR_SALES_EVENT_SLUG = process.env.CAL_OPERATOR_SALES_EVENT_SLUG || 'sales';

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

  // Split full name for the atoms Booker (requires firstName/lastName).
  // Safe for single-name or empty strings.
  const nameParts = buyerName.trim().split(/\s+/);
  const buyerFirstName = nameParts[0] || '';
  const buyerLastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

  // --- Resolve the booking URL (never-throw resolver, for iframe path) ---
  const bookingUrl = await getOperatorBookingUrl('sales');
  // Strip the cal.com origin to get the embed-ready path ('username/slug').
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
          delivery — usually 20 minutes.
        </p>
        {buyerName && (
          <p className="mt-3 text-xs text-[#92632F] font-mono">
            Reserved for {buyerName}
          </p>
        )}
      </header>

      {/* Booker — native atoms (flag-gated) with automatic iframe fallback */}
      <div className="w-full max-w-2xl">
        {NATIVE_BOOKER_ENABLED ? (
          // NativeWithFallback is a client component that renders BookerNative
          // and switches to CalInlineBooker on any atoms error boundary hit.
          <NativeWithFallback
            buyerFirstName={buyerFirstName}
            buyerLastName={buyerLastName}
            buyerEmail={buyerEmail}
            referralId={refId}
            calUsername={CAL_OPERATOR_USERNAME}
            eventSlug={CAL_OPERATOR_SALES_EVENT_SLUG}
            // Iframe fallback props (same as legacy path)
            operatorCalLink={operatorCalLink}
            name={buyerName || undefined}
            email={buyerEmail || undefined}
          />
        ) : (
          // CAL_NATIVE_BOOKER not set → battle-tested iframe, always works.
          <CalInlineBooker
            operatorCalLink={operatorCalLink}
            name={buyerName || undefined}
            email={buyerEmail || undefined}
            referralId={refId}
          />
        )}
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
