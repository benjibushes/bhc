// lib/productIntentEmail.ts
//
// REQUIRED buyer-email gate for the brand-owned product checkout mint
// (/api/checkout/product/intent). The client always requires an email, but
// until 2026-08-02 the server minted without one — a hand-crafted (or buggy)
// request could produce a PAID, receipt-less order: settlement's email chain
// starts at metadata.buyerEmail, and with it blank the buyer gets no receipt,
// no tracking, and no order-status link unless the charge recovery finds one.
//
// Pure + import-clean (no Airtable, no env) so it unit-tests under
// `tsx --test` like lib/supportIntake.ts.

/** Same pragmatic shape used funnel-wide (see lib/supportIntake.ts): the real
 *  gate is "can we send a receipt to this address". */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const INTENT_EMAIL_MAX = 200;

export type IntentEmailResult =
  | { ok: true; email: string }
  | { ok: false; error: string };

export function requireBuyerEmail(raw: unknown): IntentEmailResult {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!email) {
    return { ok: false, error: 'add your email — it’s where your receipt and tracking go.' };
  }
  if (email.length > INTENT_EMAIL_MAX || !EMAIL_RE.test(email)) {
    return { ok: false, error: "that email doesn't look right — check it and try again." };
  }
  return { ok: true, email };
}
