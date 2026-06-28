// lib/preferences.ts
//
// Flawless-handoff (2026-06-27): pure validation + formatting for the buyer
// logistics/preferences capture (POST /api/checkout/[refId]/preferences).
//
// Kept dependency-free so it unit-tests without Airtable/network. The route
// imports validatePreferences (input guard) + formatPreferencesMessage (the
// structured thread message that email-mirrors to the rancher) + the
// referral-field mapper.

export type Fulfillment = 'pickup' | 'delivery';

export interface PreferencesInput {
  fulfillment?: unknown;
  window?: unknown;
  cutNotes?: unknown;
}

export interface ValidPreferences {
  fulfillment: Fulfillment;
  window: string;
  cutNotes: string;
}

export interface ValidationOk {
  ok: true;
  value: ValidPreferences;
}
export interface ValidationErr {
  ok: false;
  error: string;
}

export const WINDOW_MAX = 200;
export const CUT_NOTES_MAX = 2000;

/**
 * Validate + normalize the buyer preferences payload.
 *
 * Rules:
 *   - fulfillment is REQUIRED and must be 'pickup' | 'delivery'.
 *   - window is optional free text, trimmed, capped at WINDOW_MAX chars.
 *   - cutNotes is optional free text, trimmed, capped at CUT_NOTES_MAX chars.
 *
 * Returns a discriminated union so the caller can branch on `ok`.
 */
export function validatePreferences(input: PreferencesInput): ValidationOk | ValidationErr {
  const fulfillmentRaw = typeof input.fulfillment === 'string' ? input.fulfillment.trim().toLowerCase() : '';
  if (fulfillmentRaw !== 'pickup' && fulfillmentRaw !== 'delivery') {
    return { ok: false, error: "fulfillment must be 'pickup' or 'delivery'" };
  }

  const window = typeof input.window === 'string' ? input.window.trim().slice(0, WINDOW_MAX) : '';
  const cutNotes = typeof input.cutNotes === 'string' ? input.cutNotes.trim().slice(0, CUT_NOTES_MAX) : '';

  return {
    ok: true,
    value: { fulfillment: fulfillmentRaw as Fulfillment, window, cutNotes },
  };
}

/** Human label for the fulfillment choice. */
export function fulfillmentLabel(f: Fulfillment): string {
  return f === 'delivery' ? 'Delivery' : 'Pickup';
}

/**
 * Build the structured first-message body posted into the buyer↔rancher thread.
 * Plain text (the thread mirrors to the rancher by email) — deliberately
 * scannable so the rancher reads it at a glance before the first call.
 */
export function formatPreferencesMessage(
  prefs: ValidPreferences,
  opts: { buyerFirstName?: string } = {},
): string {
  const who = (opts.buyerFirstName || '').trim();
  const lead = who ? `Buyer preferences from ${who}:` : 'Buyer preferences:';
  const lines = [
    lead,
    `• Fulfillment: ${fulfillmentLabel(prefs.fulfillment)}`,
    `• Target window: ${prefs.window || 'flexible / no preference yet'}`,
    `• Cut notes: ${prefs.cutNotes || 'none yet — open to your standard cut sheet'}`,
  ];
  return lines.join('\n');
}

/**
 * Map validated preferences onto the Referral record fields. Centralized so the
 * route + any future caller stamp the SAME field names. A `Buyer Preferences
 * Set At` ISO timestamp doubles as the idempotency marker.
 *
 * Airtable fields (NEW — see return below):
 *   - Buyer Fulfillment Pref   (singleLineText: 'Pickup' | 'Delivery')
 *   - Buyer Window Pref        (singleLineText)
 *   - Buyer Cut Notes          (long text)
 *   - Buyer Preferences Set At (date/time, ISO)
 */
export function preferencesToReferralFields(
  prefs: ValidPreferences,
  nowIso: string,
): Record<string, string> {
  return {
    'Buyer Fulfillment Pref': fulfillmentLabel(prefs.fulfillment),
    'Buyer Window Pref': prefs.window,
    'Buyer Cut Notes': prefs.cutNotes,
    'Buyer Preferences Set At': nowIso,
  };
}
