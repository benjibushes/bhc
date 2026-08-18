// lib/marketingTouch.ts
//
// CROSS-RAIL MARKETING COOLDOWN — the ONE shared answer to "when did ANY
// marketing rail last touch this buyer?" (Wave 1 rails hardening, F9+F18,
// 2026-08-18).
//
// THE BUG CLASS THIS KILLS: every marketing rail kept its own recency gate
// over its OWN stamp only —
//   • email-sequences' "never two in 1 day" read only `Sequence Sent At`,
//   • the demand-router's Msg1 branch ignored `Campaign Last Sent At` when
//     `Campaign Stage` was empty (the autopilot claim shape), so an
//     autopilot-claimed buyer was immediately Msg1-eligible,
//   • nurture-drip had no cross-rail check at all,
// so two rails firing on adjacent crons could email the same buyer twice in
// one day with conflicting CTAs.
//
// THE RULE: at least DEFAULT_MARKETING_COOLDOWN_HOURS (24h) between ANY two
// MARKETING touches, across rails, in both directions. Chase/transactional
// rails (deposit-request nudge, no-action nudge, referral chase, reserve
// recovery of an already-held slot) are deliberately NOT gated — a buyer
// mid-payment must still be chased — and their stamps are deliberately NOT
// in the field list below.
//
// FIELD LIST DISCIPLINE: every entry below is a REAL Consumers field written
// by a real rail (file:writer noted inline — never guess Airtable field
// names, CLAUDE.md hard rule 1). Adding a new marketing rail = add its stamp
// here and every consumer of this helper inherits the gate.
//
// Hermetic on purpose — zero imports, no Airtable, no env — so pure libs
// (lib/demandRouter, lib/campaignWaves) and cron routes can all pull it
// without dragging a dependency graph along.

/**
 * Consumers-table stamps that mean "a MARKETING rail emailed/texted this
 * buyer at that moment". Chase/transactional stamps (Waiting Nudge Last Sent
 * At, Ready Nudge Last Sent At, referral-table chase stamps) are excluded by
 * design — the cooldown gates marketing only.
 */
export const MARKETING_TOUCH_FIELDS: readonly string[] = [
  // Demand-router wave sends (stampSend, app/api/cron/demand-router) AND the
  // requalify/autopilot first-touch claim (app/api/campaign/requalify-send) —
  // both rails write into this shared namespace by construction.
  'Campaign Last Sent At',
  // Demand-router SMS recovery (runSmsRecovery, app/api/cron/demand-router).
  'Campaign SMS Recovery Sent At',
  // Nurture drip touches 1-4 (app/api/cron/nurture-drip).
  'Nurture Touched At',
  // Email-sequences stage machine + abandoned recovery + segment branches
  // (app/api/cron/email-sequences).
  'Sequence Sent At',
  // Email-sequences segment branch belt — always written alongside Sequence
  // Sent At, kept separately so a legacy/partial row still counts.
  'Routing Segment Last Sent At',
  // Rancher-launch warmup announcement (app/api/cron/rancher-launch-warmup,
  // app/api/admin/consumers/[id]/resend-warmup).
  'Warmup Sent At',
];

/** Default gap required between any two marketing touches across rails. */
export const DEFAULT_MARKETING_COOLDOWN_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

/**
 * The most recent marketing-touch timestamp on a Consumers row, in ms epoch.
 * 0 when the buyer has never been marketing-touched (or every stamp is
 * blank/garbage). Pure + throw-safe over raw Airtable-shaped rows.
 */
export function lastMarketingTouchMs(
  record: Record<string, unknown> | null | undefined,
): number {
  if (!record) return 0;
  let max = 0;
  for (const f of MARKETING_TOUCH_FIELDS) {
    const v = record[f];
    if (!v) continue;
    const t = new Date(String(v)).getTime();
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/**
 * True iff this buyer is OUTSIDE the cross-rail marketing cooldown — i.e. a
 * marketing rail may touch them now. Never-touched buyers pass. A stamp in
 * the FUTURE (clock skew, bad write) counts as recent — blocked — because
 * fail-closed is the only safe answer for a sender.
 *
 * `now` is injected for deterministic testing.
 */
export function cooledDown(
  record: Record<string, unknown> | null | undefined,
  now: number,
  hours: number = DEFAULT_MARKETING_COOLDOWN_HOURS,
): boolean {
  const last = lastMarketingTouchMs(record);
  if (!last) return true;
  return now - last >= hours * HOUR_MS;
}
