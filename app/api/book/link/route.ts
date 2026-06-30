// app/api/book/link/route.ts
//
// Public resolver for the operator's LIVE booking link. Client components
// (the apply discovery embed, the rancher-setup onboarding embed) cannot call
// the server-only resolver directly (lib/calBooking.getOperatorBookingUrl reads
// CAL_API_KEY). They fetch this endpoint instead and embed the resolved live
// cal.com event — never a hardcoded slug.
//
// This kills the recurring "broken booking link" class: those /15min, /30min,
// /sales events were deleted (incidents 2026-06-14/15) yet still live in stale
// NEXT_PUBLIC_CALENDLY_LINK env values from 142d ago. The resolver confirms a
// LIVE event via the Cal API on every call, so the embed is always current.
//
//   GET /api/book/link?purpose=sales    -> Ben's buyer sales call (default)
//   GET /api/book/link?purpose=rancher  -> rancher-onboarding call
//
// Returns:
//   { purpose, url, calLink, contactFallback }
//   - url:      full https://cal.com/... URL when a live, EMBEDDABLE event
//               exists; null when the resolver fell back to /contact.
//   - calLink:  'username/slug' (embed-ready) or null.
//   - contactFallback: the /contact URL when no live event (so callers can
//               show a graceful "email us" path instead of a dead iframe).

import { NextRequest, NextResponse } from 'next/server';
import { getOperatorBookingUrl, type BookingPurpose } from '@/lib/calBooking';

export const dynamic = 'force-dynamic';

const CAL_HOST_RE = /^https?:\/\/(www\.|app\.)?cal\.com\//i;

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('purpose');
  const purpose: BookingPurpose = raw === 'rancher' ? 'rancher' : 'sales';

  // Live cal.com URL or a /contact fallback — never a 404-able slug.
  let resolved = '';
  try {
    resolved = await getOperatorBookingUrl(purpose);
  } catch {
    resolved = '';
  }

  const embeddable = CAL_HOST_RE.test(resolved);

  return NextResponse.json(
    {
      purpose,
      url: embeddable ? resolved : null,
      calLink: embeddable ? resolved.replace(CAL_HOST_RE, '') : null,
      contactFallback: embeddable ? null : resolved || null,
    },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
}
