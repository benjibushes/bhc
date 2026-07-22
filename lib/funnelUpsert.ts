// lib/funnelUpsert.ts
//
// Pure guard for the /api/consumers funnel contact-step UPSERT (2026-07-22,
// reactivation audit). The upsert used to write Buyer Stage='WAITING',
// Created=today, Approved At=now, and Source unconditionally onto ANY
// email-matched record — so a MATCHED buyer (live referral) or CLOSED buyer
// clicking a months-old reactivation email was regressed to WAITING at the
// contact step (re-selected by waiting-activation, invisible to the
// matched-buyer chase rails), signup-date truth was destroyed (Created feeds
// /api/stats/public activity), and first-touch attribution was clobbered.
//
// Rules (product decision, launch defaults):
//   • NEVER downgrade Buyer Stage — only (re)write WAITING when the current
//     stage is blank, NEW, or WAITING.
//   • NEVER overwrite Created / Approved At / Source when already set.

// Stages where a (re)write of WAITING is not a downgrade.
const STAGE_SAFE_FOR_WAITING = ['', 'NEW', 'WAITING'];

export function guardFunnelUpsertFields(
  fields: Record<string, unknown>,
  existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!existing) return fields;
  const out = { ...fields };
  const currentStage = String(existing['Buyer Stage'] || '').trim();
  if (!STAGE_SAFE_FOR_WAITING.includes(currentStage)) {
    delete out['Buyer Stage'];
    delete out['Buyer Stage Updated At'];
  }
  if (existing['Created']) delete out['Created'];
  if (existing['Approved At']) delete out['Approved At'];
  if (existing['Source']) delete out['Source'];
  return out;
}
