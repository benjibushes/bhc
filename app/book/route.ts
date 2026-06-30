// app/book/route.ts
//
// Stable "book a call with Ben" redirect. EVERY book-a-call CTA — campaign
// emails, the deposit checkout page, the qualified deposit email, the rancher
// storefront operator default — points here instead of a hardcoded cal.com
// slug. At click time we resolve the LIVE Cal event via the guarded resolver
// (lib/calBooking.getOperatorBookingUrl), which confirms a live event or falls
// back to /contact. So this link can NEVER 404 — it fixes the recurring
// "broken booking link" class (incidents 2026-06-14/15) and the hardcoded slug
// re-introduced by the book-a-call work (#147/#152).
//
//   /book              -> Ben's sales call (default)
//   /book?purpose=rancher -> rancher-onboarding call
//   /book?name=&email= -> forwarded as Cal prefill

import { NextRequest, NextResponse } from 'next/server';
import { getOperatorBookingUrl, type BookingPurpose } from '@/lib/calBooking';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const purpose: BookingPurpose = sp.get('purpose') === 'rancher' ? 'rancher' : 'sales';

  // Live Cal URL or /contact — never a 404 slug.
  let target = await getOperatorBookingUrl(purpose);

  // Forward Cal prefill params so the buyer doesn't re-type name/email.
  // Skip when we fell back to /contact (not a Cal page).
  if (!target.includes('/contact')) {
    const extra: string[] = [];
    const name = sp.get('name');
    const email = sp.get('email');
    if (name) extra.push(`name=${encodeURIComponent(name)}`);
    if (email) extra.push(`email=${encodeURIComponent(email)}`);
    if (extra.length) target += (target.includes('?') ? '&' : '?') + extra.join('&');
  }

  return NextResponse.redirect(target, 302);
}
