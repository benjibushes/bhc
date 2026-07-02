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
