// lib/buyerZip.ts
//
// BUYER ZIP CAPTURE (2026-07-25, founder directive: "when we gather customer
// information through the funnel or order forms or anything, we gather their
// ZIP code").
//
// Two jobs, both pure:
//
//   1. zipFromStripePayment — pull a usable US ZIP out of a Stripe
//      PaymentIntent / Checkout Session. This is how the FAST self-serve
//      checkouts capture a ZIP without asking for one: Stripe already collects
//      an address at payment, so we harvest it at settlement instead of
//      charging the buyer an extra form field before the money moves.
//
//   2. buyerZipPatch — the Airtable patch that writes Consumers.`Zip`
//      (fldGm54EreQD6pYju). Writes ONLY a normalized 5-digit US ZIP, and never
//      stomps a ZIP the buyer told us themselves — a Stripe-derived billing ZIP
//      is weaker evidence than one they typed. A stored blank/garbage value IS
//      healed, since it was never usable for routing anyway.
//
// The ELIGIBILITY decision is NOT here — that stays in lib/exclusiveZip
// (buyerZipServedBy / hasServiceZipGate), which is the single documented
// fail-closed contract. This module only produces the ZIP that gate consumes.
//
// Import discipline matches lib/exclusiveZip: normalizeZip from ./zipFormat,
// NEVER ./zipCentroids (1 MB table, and a prefix/format check never needs a
// centroid).

import { normalizeZip } from './zipFormat';

/**
 * Buyer-facing copy for a ZIP-gate rejection, shared by every self-serve buy
 * path so the message is identical everywhere.
 *
 * Deliberately says nothing about WHY: no ZIP, no ranch name, no "exclusive",
 * no territory. A buyer must never be able to map another rancher's contracted
 * service area by probing checkout. It points at the quiz instead, which is a
 * real next step (it re-routes them to a rancher who CAN serve them) rather
 * than a dead end.
 */
export const ZIP_OUT_OF_AREA_MESSAGE =
  "This ranch can't take orders for your area right now. Take the 90-second quiz and we'll match you with one that can.";

/** Safe property read — Stripe payloads are `any`-shaped and often partial. */
function at(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  return (obj as Record<string, unknown>)[key];
}

/** postal_code off a Stripe `{ address: { postal_code } }` shaped node. */
function postalOf(node: unknown): unknown {
  return at(at(node, 'address'), 'postal_code');
}

/**
 * Best available US ZIP from a Stripe PaymentIntent or Checkout Session.
 *
 * Preference order is SHIPPING first — where the beef actually goes is what a
 * service-area question is about — then billing, then the customer record.
 * Each candidate is run through normalizeZip, and a candidate that doesn't
 * normalize (blank, non-US postal code, junk) is SKIPPED rather than
 * short-circuiting, so one unusable field can't hide a usable one further
 * down. Returns null when nothing usable is present — callers must treat that
 * as "we still don't know", never as a value to persist.
 */
export function zipFromStripePayment(source: unknown): string | null {
  if (source === null || typeof source !== 'object') return null;

  const charge = (() => {
    const data = at(at(source, 'charges'), 'data');
    return Array.isArray(data) ? data[0] : undefined;
  })();

  const candidates: unknown[] = [
    // Checkout Session — shipping address the buyer entered.
    postalOf(at(source, 'shipping_details')),
    postalOf(at(at(source, 'collected_information'), 'shipping_details')),
    // PaymentIntent — shipping on the charge is the reliably-populated one for
    // direct-charge Checkout (see lib/productSettlement formatShipping).
    postalOf(at(charge, 'shipping')),
    postalOf(at(source, 'shipping')),
    // Billing address off the card.
    postalOf(at(charge, 'billing_details')),
    postalOf(at(source, 'customer_details')),
  ];

  for (const c of candidates) {
    const zip = normalizeZip(c);
    if (zip) return zip;
  }
  return null;
}

/**
 * Airtable field patch for Consumers.`Zip`.
 *
 *  - No / malformed incoming ZIP ⇒ `{}` (a bad value is never persisted).
 *  - Existing row already holds a valid ZIP ⇒ `{}` (buyer-declared wins).
 *  - Otherwise ⇒ `{ Zip: <normalized> }`.
 *
 * Returning an empty object (rather than throwing or writing null) lets every
 * caller spread it into an existing patch unconditionally: `{ ...patch,
 * ...buyerZipPatch(zip, row['Zip']) }` is a no-op when there's nothing to say.
 */
export function buyerZipPatch(
  incomingZip: unknown,
  existingZip: unknown,
): Record<string, string> {
  const zip = normalizeZip(incomingZip);
  if (!zip) return {};
  if (normalizeZip(existingZip)) return {}; // already have a real one — don't stomp it
  return { Zip: zip };
}
