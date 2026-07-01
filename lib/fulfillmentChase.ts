// lib/fulfillmentChase.ts
//
// E3/B15 (2026-07-01) — pure selection logic for the fulfillment-chase cron
// (app/api/cron/fulfillment-chase/route.ts). A deposit-paid (non-refundable
// for the buyer), rancher-accepted referral whose Processing Date passes with
// no fulfillment confirmation previously sat frozen forever: no rancher nudge,
// no operator escalation. This module decides WHO gets chased and at WHICH
// escalation tier; the route stays a thin shell (auth, Airtable IO, sends).
//
// PURE — no IO, no env reads, `now` injected — so it unit-tests without a
// live Airtable. Run: JWT_SECRET=test-secret-ci npx tsx --test lib/fulfillmentChase.test.ts
//
// Escalation tiers (days past the due date):
//   T+2d → tier 1: gentle rancher nudge email ("one tap confirms")
//   T+5d → tier 2: second rancher nudge + LOUD operator signal (money at risk)
//   T+8d → tier 3: operator signal only — a human takes over. We deliberately
//          do NOT email the buyer promises we can't verify; buyer comms at
//          this stage is Ben's call.
//
// Guards:
//   - one send per tier: `Fulfillment Chase Count` doubles as "highest tier
//     already sent", so a referral is only re-touched when it ESCALATES.
//   - 48h cooldown between sends (belt-and-braces vs manual stamp edits).
//   - 3 lifetime chases, hard cap.
//   - a referral discovered deep in the window (cron was down, backfill) gets
//     ONE entry at the highest due tier — never a catch-up burst.

import { FULFILLMENT_FIELDS } from './fulfillmentTracking';

export type ChaseTier = 1 | 2 | 3;

export interface ChaseCandidate {
  referralId: string;
  tier: ChaseTier;
  daysPastDue: number;
}

// Stamp fields this cron writes on Referrals. NEW — the founder must create
// them in Airtable before sends happen (the route verifies the first stamp
// persisted and aborts if not; updateRecord silently strips unknown fields).
export const CHASE_FIELDS = {
  lastSentAt: 'Fulfillment Chase Last Sent At', // date with time
  count: 'Fulfillment Chase Count', // number (integer)
} as const;

export const CHASE_AIRTABLE_FIELDS_NEEDED: readonly string[] = [
  'Fulfillment Chase Last Sent At (date with time)',
  'Fulfillment Chase Count (number, integer)',
] as const;

// Tier thresholds in whole days past the due date.
export const TIER_1_DAYS = 2;
export const TIER_2_DAYS = 5;
export const TIER_3_DAYS = 8;

// No re-send within this window, regardless of tier.
export const COOLDOWN_HOURS = 48;

// Never more than this many chase touches per referral, ever.
export const MAX_LIFETIME_CHASES = 3;

// When a referral has no Processing Date, due date = Rancher Accepted At +
// this many days. 30d ≈ a generous processing-run window; overridable via
// FULFILLMENT_CHASE_FALLBACK_DAYS in the route.
export const DEFAULT_FALLBACK_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function parseMs(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const t = new Date(String(v)).getTime();
  return Number.isNaN(t) ? null : t;
}

function tierForDays(daysPastDue: number): ChaseTier | null {
  if (daysPastDue >= TIER_3_DAYS) return 3;
  if (daysPastDue >= TIER_2_DAYS) return 2;
  if (daysPastDue >= TIER_1_DAYS) return 1;
  return null;
}

/**
 * Select the referrals due for a fulfillment chase, with their tier.
 *
 * `referrals` are raw Airtable Referrals rows (flattened fields, as returned
 * by getAllRecords). The route pre-filters on long-standing fields only
 * ({Deposit Paid At}, {Rancher Accepted At}, {Status}); every check that
 * touches a possibly-missing field (Fulfillment Confirmed At, Fulfillment
 * Status, the chase stamps) happens HERE in JS, where an absent field is just
 * `undefined` — the {Refunded At} lesson from deposit-accept-sla.
 *
 * Returns most-overdue first so a per-run cap (MAX_PER_RUN) always reaches
 * the worst cases.
 */
export function selectFulfillmentChase(
  referrals: Array<Record<string, any>>,
  opts: { nowISO: string; fallbackDays?: number },
): ChaseCandidate[] {
  const now = parseMs(opts.nowISO);
  if (now === null) return [];
  const fallbackDays =
    typeof opts.fallbackDays === 'number' && opts.fallbackDays > 0
      ? opts.fallbackDays
      : DEFAULT_FALLBACK_DAYS;

  const out: ChaseCandidate[] = [];

  for (const ref of referrals || []) {
    if (!ref || !ref.id) continue;

    // Defense in depth — the formula already requires these.
    if (!ref['Deposit Paid At'] || !ref['Rancher Accepted At']) continue;

    // Already confirmed via EITHER path: the legacy binary confirm
    // (/api/rancher/fulfillment/confirm) or the richer tracker.
    if (ref['Fulfillment Confirmed At']) continue;
    if (String(ref[FULFILLMENT_FIELDS.status] || '').toLowerCase() === 'fulfilled') continue;

    // Dead deals. The formula excludes 'Closed Lost'; 'refunded' is
    // belt-and-braces for any drifted/legacy status value.
    const status = String(ref['Status'] || '').toLowerCase();
    if (status === 'closed lost' || status === 'refunded') continue;

    // Due date: Processing Date when parseable, else accept date + fallback.
    let due = parseMs(ref[FULFILLMENT_FIELDS.processingDate]);
    if (due === null) {
      const accepted = parseMs(ref['Rancher Accepted At']);
      if (accepted === null) continue; // no due date derivable
      due = accepted + fallbackDays * DAY_MS;
    }

    const daysPastDue = Math.floor((now - due) / DAY_MS);
    const tier = tierForDays(daysPastDue);
    if (tier === null) continue;

    // Lifetime cap.
    const count = Number(ref[CHASE_FIELDS.count]) || 0;
    if (count >= MAX_LIFETIME_CHASES) continue;

    // One send per tier: count is the highest tier already sent. Only touch
    // again when the referral has escalated PAST what we've already sent.
    if (tier <= count) continue;

    // Cooldown — never two sends within 48h even across tiers.
    const lastSent = parseMs(ref[CHASE_FIELDS.lastSentAt]);
    if (lastSent !== null && now - lastSent < COOLDOWN_HOURS * 60 * 60 * 1000) continue;

    out.push({ referralId: String(ref.id), tier, daysPastDue });
  }

  // Most overdue first.
  out.sort((a, b) => b.daysPastDue - a.daysPastDue);
  return out;
}
