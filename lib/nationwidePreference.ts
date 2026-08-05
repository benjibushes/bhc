// lib/nationwidePreference.ts
//
// Buyer matching preference for the CONTROLLED NATIONWIDE FALLBACK
// (founder directive, 2026-07-01): buyers can OPT IN to being matched with a
// nationwide-shipping rancher (buy sooner) or OPT OUT (wait for local).
//
// Backing field: Consumers.'Nationwide Preference' — an Airtable singleSelect
// (fldY1XpbC0fNVI6bw) with exactly two options:
//   'nationwide-ok' → buyer opted in  → nationwide fallback allowed
//   'local-only'    → buyer opted out → nationwide fallback SKIPPED
//   empty / unset   → buyer was never asked → fallback allowed (pre-feature
//                     behavior — existing buyers lose NOTHING)
//
// A singleSelect (not a checkbox) because the semantics are tri-state:
// explicit opt-out must be distinguishable from never-asked, and a checkbox
// collapses "false" and "empty" into the same value.
//
// Pure + dependency-free so the gate unit-tests without Airtable/network.

export const NATIONWIDE_PREFERENCE_FIELD = 'Nationwide Preference';
export const NATIONWIDE_OK = 'nationwide-ok';
export const LOCAL_ONLY = 'local-only';

/**
 * Normalize the raw Airtable field value to a lowercase trimmed string.
 * Airtable singleSelect fields arrive as a plain string OR an
 * {id, name, color} object depending on read path — handle both shapes
 * (same dual-shape handling as tierFor in lib/tiers.ts). Anything else
 * (unset, null, numbers, booleans, arrays) → '' (treated as never-asked).
 */
export function normalizeNationwidePreference(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim().toLowerCase();
  if (raw && typeof raw === 'object' && typeof (raw as any).name === 'string') {
    return String((raw as any).name).trim().toLowerCase();
  }
  return '';
}

/**
 * The matching gate. Returns false ONLY for an explicit 'local-only' opt-out.
 * Every other value — opted-in, unset, null, garbage — allows the fallback,
 * so no buyer can lose matching without an explicit choice. Fail-open by
 * design: a corrupted field value must never silently strand a buyer.
 */
export function nationwideAllowed(raw: unknown): boolean {
  return normalizeNationwidePreference(raw) !== LOCAL_ONLY;
}

/**
 * GLOBAL nationwide-routing kill switch. The nationwide FALLBACK in
 * app/api/matching/suggest (a buyer with no in-state rancher matched to a
 * Ships-Nationwide + Admin-Approved-Multi-State rancher) fires ONLY when this
 * returns true.
 *
 * Default TRUE — INVERTED 2026-08-04 (operator decision: "unblock everything
 * we can — put gas on the machine"). The 2026-07-05 default-off era ("grow
 * local density first") is over: a no-local-supply buyer may now route to an
 * approved nationwide shipper by default. Only an explicit 'false' in Vercel
 * kills the fallback globally (same inverted semantics as MATCHING_ENABLED);
 * unset, 'true', or any other value = ON.
 *
 * This switch was never the ONLY gate, and the other two still apply on top —
 * all three must pass for the fallback to fire:
 *   • per-buyer opt-in/opt-out (nationwideAllowed above — 'local-only' buyers
 *     always stay local), and
 *   • the BUYER-FIT gate (lib/nationwideFit.ts, same 2026-08-04 decision):
 *     a specialty/premium nationwide rancher only receives buyers whose
 *     budget or expressed beef interest actually fits them.
 */
export function nationwideRoutingEnabled(): boolean {
  return process.env.NATIONWIDE_ROUTING_ENABLED !== 'false';
}
