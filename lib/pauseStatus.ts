// lib/pauseStatus.ts
//
// E4b (2026-07-01) — pure validation for the rancher self-serve pause/resume
// toggle. 'Active Status' drives routing eligibility (lib/rancherEligibility
// gates on === 'Active'; 'Paused' is excluded), so letting ranchers write it
// at all is dangerous. This module is the STRICT gate the landing-page PATCH
// uses:
//
//   1. VALUE whitelist — a rancher may only ever write exactly 'Active' or
//      'Paused'. Never 'Removed', never 'At Capacity', never arbitrary text.
//   2. TRANSITION guard — only from an already-live state. Without this, a
//      Removed/Pending rancher could self-ACTIVATE through the whitelist,
//      bypassing admin gating entirely.
//
// PURE — no IO. Unit-tested (lib/pauseStatus.test.ts).

/** The ONLY values a rancher may self-write to 'Active Status'. */
export const PAUSE_TOGGLE_VALUES = ['Active', 'Paused'] as const;
export type PauseToggleValue = (typeof PAUSE_TOGGLE_VALUES)[number];

/**
 * Current statuses from which the self-serve toggle is allowed. Anything else
 * ('Removed', 'Pending', empty, …) means the account isn't live — pausing is
 * meaningless and resuming would be self-activation.
 */
export const SELF_SERVE_PAUSE_CURRENT_STATES = ['Active', 'At Capacity', 'Paused'] as const;

/** Airtable singleSelects sometimes hydrate as { name } — read either form. */
function readStatusString(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object' && 'name' in v) {
    return String((v as { name?: unknown }).name || '').trim();
  }
  return '';
}

export type PauseValueResult =
  | { ok: true; value: PauseToggleValue }
  | { ok: false; error: string };

/**
 * Validate a client-supplied 'Active Status' value. Strings only; trims and
 * case-normalizes to the canonical value ('paused' → 'Paused') so the stored
 * value is always EXACTLY one of PAUSE_TOGGLE_VALUES. Everything else — other
 * statuses, arbitrary text, non-strings — is rejected.
 */
export function validatePauseValue(v: unknown): PauseValueResult {
  const error = 'Active Status can only be set to "Active" or "Paused".';
  if (typeof v !== 'string') return { ok: false, error };
  const t = v.trim().toLowerCase();
  const match = PAUSE_TOGGLE_VALUES.find((canonical) => canonical.toLowerCase() === t);
  if (!match) return { ok: false, error };
  return { ok: true, value: match };
}

/**
 * Guard the transition: the rancher's CURRENT status must be a live state
 * ('Active' / 'At Capacity' / 'Paused'). Blocks self-activation from
 * 'Removed', 'Pending', or unset — those flips stay admin-only.
 */
export function validatePauseTransition(
  current: unknown,
  _requested: PauseToggleValue
): { ok: boolean; error?: string } {
  const cur = readStatusString(current);
  if (!(SELF_SERVE_PAUSE_CURRENT_STATES as readonly string[]).includes(cur)) {
    return {
      ok: false,
      error: 'Pause and resume are only available once your account is live. Contact support if something looks wrong.',
    };
  }
  return { ok: true };
}
