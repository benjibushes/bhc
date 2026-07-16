// lib/lossReasons.ts
//
// ONE vocabulary for why a deal died. Referrals carry a 'Loss Reason'
// singleSelect (fldV4hf0ptyhMaaAA) whose choices are pinned below — every
// rancher-initiated close surface (dashboard Mark Lost modal, dashboard pass
// rail, email quick-action lost/pass links) maps its own option codes onto
// these EXACT strings so the field aggregates cleanly. Forensic audit
// 2026-07-15: 1,460 Closed Lost/Dormant rows had reasons scattered across
// free-text Notes stamps in 3 incompatible formats — unqueryable. The Notes
// stamps stay (backward compat + free text), the structured field is new.
//
// SCHEMA DRIFT WARNING: every write path rides the shared Airtable helpers
// (createRecord/updateRecord), which hardcode typecast:true — a string that
// drifts from the prod schema by one byte would silently mint a new select
// option, not throw. The guard is twofold: (1) nothing writes this field
// except through the pinned vocabulary below (isLossReasonChoice + the
// mapping tables), and (2) the 7 strings were verified codepoint-for-
// codepoint against prod schema fldV4hf0ptyhMaaAA on 2026-07-15 (em-dash
// U+2014 in 'Timing', straight apostrophe U+0027 in "Couldn't"). If you edit
// LOSS_REASON_CHOICES, re-verify against the live schema before deploy.

export const LOSS_REASON_CHOICES = [
  'Price too high',
  'Timing — buying later',
  "Couldn't reach buyer",
  'Bought elsewhere',
  'Out of service area',
  'Wrong intent (not a buyer)',
  'Other',
] as const;

export type LossReason = (typeof LOSS_REASON_CHOICES)[number];

export function isLossReasonChoice(v: unknown): v is LossReason {
  return typeof v === 'string' && (LOSS_REASON_CHOICES as readonly string[]).includes(v);
}

// Dashboard Mark Lost modal → PATCH body `closeReason`. Legacy codes
// (no_response / price / not_a_fit / other) kept so an open dashboard tab
// from before this deploy still maps; new codes match the new modal options.
const CLOSE_REASON_TO_LOSS: Record<string, LossReason> = {
  no_response: "Couldn't reach buyer",
  price: 'Price too high',
  timing: 'Timing — buying later',
  bought_elsewhere: 'Bought elsewhere',
  wrong_intent: 'Wrong intent (not a buyer)',
  not_a_fit: 'Other',
  other: 'Other',
};

export function lossReasonFromCloseReason(code: string | null | undefined): LossReason | null {
  if (!code) return null;
  return CLOSE_REASON_TO_LOSS[code] ?? null;
}

// Dashboard pass rail → PATCH body `passReason`. at_capacity / not_a_fit are
// the rancher's situation, not a buyer outcome — they land in 'Other' and the
// existing [PASSED …] Notes stamp keeps the specific label.
const PASS_REASON_TO_LOSS: Record<string, LossReason> = {
  out_of_area: 'Out of service area',
  at_capacity: 'Other',
  not_a_fit: 'Other',
  no_response: "Couldn't reach buyer",
};

export function lossReasonFromPassReason(code: string | null | undefined): LossReason | null {
  if (!code) return null;
  return PASS_REASON_TO_LOSS[code] ?? null;
}

// Email quick-action lost form. The new form submits the exact choice strings
// (identity), but a form rendered pre-deploy can still POST the legacy values
// — map those too instead of dropping the signal.
const QUICK_ACTION_LEGACY_TO_LOSS: Record<string, LossReason> = {
  'No response': "Couldn't reach buyer",
  'Price': 'Price too high',
  'Timing': 'Timing — buying later',
  'Out of area': 'Out of service area',
  'At capacity': 'Other',
};

export function lossReasonFromQuickAction(reason: string | null | undefined): LossReason | null {
  if (!reason) return null;
  if (isLossReasonChoice(reason)) return reason;
  return QUICK_ACTION_LEGACY_TO_LOSS[reason] ?? null;
}
