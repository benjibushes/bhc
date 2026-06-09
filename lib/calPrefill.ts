// lib/calPrefill.ts
//
// Single source of truth for adding Cal.com booking-form prefill query
// params to outbound Cal URLs. Cal accepts standard query params on every
// event-type page:
//   ?name=<full name>            — pre-fills the "Your name" field
//   ?email=<email>               — pre-fills the "Email" field
//   ?notes=<text>                — pre-fills the "Additional notes" field
//   ?metadata[key]=<value>       — passes structured metadata back via webhook
//                                  (lands in payload.metadata for our handler)
//
// Why it lives here: every outbound BHC email that links to Cal.com should
// route through this helper. Without it, ranchers and buyers re-type their
// name + email on every booking, killing the "seamless" funnel feel.
//
// Webhook side: app/api/webhooks/cal/route.ts reads bookingPayload.metadata
// to match the booking back to the source record (rancherId for migration
// calls, referralId for buyer sales calls). Use the same metadata keys the
// webhook expects — see CalPrefillMetadata below.

export interface CalPrefillMetadata {
  // Rancher migration calls (Ben hosts, rancher attends)
  rancherId?: string;
  // Buyer sales/intro calls (Ben or rancher hosts, buyer attends)
  referralId?: string;
  // Buyer ID — useful for analytics + post-booking enrichment
  buyerId?: string;
  // Free-form attribution (campaign, ad set, etc)
  source?: string;
}

export interface CalPrefillInput {
  name?: string;          // Full name (Cal pre-fills "Your name")
  email?: string;         // Email (Cal pre-fills "Email")
  notes?: string;         // Optional notes (Cal pre-fills "Additional notes")
  metadata?: CalPrefillMetadata;
}

/**
 * Append Cal.com booking-form prefill query params to a Cal URL.
 *
 * Handles URLs that already contain a querystring + URL-encoding +
 * metadata[key]=value syntax that Cal expects.
 *
 * @example
 *   addCalPrefill('https://cal.com/ben-beauchman-1itnsg/sales', {
 *     name: 'Jane Doe',
 *     email: 'jane@example.com',
 *     metadata: { referralId: 'recABC123' },
 *   })
 *   // → 'https://cal.com/ben-beauchman-1itnsg/sales?name=Jane+Doe&email=jane%40example.com&metadata%5BreferralId%5D=recABC123'
 */
export function addCalPrefill(url: string, input: CalPrefillInput): string {
  if (!url) return url;
  const params = new URLSearchParams();
  if (input.name) params.set('name', input.name);
  if (input.email) params.set('email', input.email);
  if (input.notes) params.set('notes', input.notes);
  if (input.metadata) {
    for (const [key, val] of Object.entries(input.metadata)) {
      if (val) params.set(`metadata[${key}]`, String(val));
    }
  }
  const qs = params.toString();
  if (!qs) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${qs}`;
}
