// Ben's sales scheduling link. Single source of truth so campaign emails, the
// deposit checkout page, the qualified deposit email, and the rancher
// storefront all route "talk first" buyers to the same place.
//
// Points at the /book redirect (NOT a hardcoded cal.com slug). /book resolves
// the LIVE Cal event at click time via lib/calBooking.getOperatorBookingUrl
// (confirms a live event or falls back to /contact), so the link can never 404
// — fixes the "broken booking link" class. See app/book/route.ts.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
export const BEN_SALES_CAL_URL = `${SITE_URL}/book`;
