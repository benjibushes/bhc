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
// Wave 2 rework (2026-07-29) — killing the 32-day silence. The old shape only
// chased AFTER a due date passed, and with no Processing Date (the normal
// state) the due date fell back to accept+30d — first rancher touch at
// accept+32d while the buyer's non-refundable money sat in silence. Now:
//   - Due-date source: Handoff Date > Processing Date > accept + 14d.
//   - NEW 'schedule' kind: accepted ≥3d with NO Handoff Date and NO
//     Processing Date → one gentle "pick a date" rancher email.
//   - NEW 'invoice' kind: accepted ≥7d, final invoice never sent, money not
//     otherwise confirmed → "time to send the final invoice" rancher email
//     (max 2 touches).
//   - Both new kinds skip 'rancher-added' CRM leads (#511 — the rancher's own
//     customer; BHC automation stays out of that relationship) and NEVER email
//     the buyer (deliberate — this cron can't verify what actually happened).
//
// Escalation tiers for the 'confirm' kind (days past the due date):
//   T+2d → tier 1: gentle rancher nudge email ("one tap confirms")
//   T+5d → tier 2: second rancher nudge + LOUD operator signal (money at risk)
//   T+8d → tier 3: operator signal only — a human takes over. We deliberately
//          do NOT email the buyer promises we can't verify; buyer comms at
//          this stage is Ben's call.
//
// Guards (SHARED stamps across all kinds — `Fulfillment Chase Last Sent At` +
// `Fulfillment Chase Count`):
//   - one send per confirm tier: Count doubles as "highest tier already
//     sent", so a referral is only re-touched when it ESCALATES. The new
//     kinds consume the same ladder: 'schedule' fires only at Count 0,
//     'invoice' only at Count ≤1 (its cap of 2), so the total per-referral
//     touch budget stays bounded.
//   - 48h cooldown between sends (belt-and-braces vs manual stamp edits).
//   - 3 lifetime chases, hard cap.
//   - a referral discovered deep in the window (cron was down, backfill) gets
//     ONE entry at the highest due tier — never a catch-up burst.
//   - at most ONE candidate per referral per run (kind priority:
//     confirm > invoice > schedule).

import { FULFILLMENT_FIELDS } from './fulfillmentTracking';

export type ChaseTier = 1 | 2 | 3;

// Wave 2 (2026-07-29): which ask this touch carries.
//   confirm  — due date passed, no fulfillment confirmation (the original).
//   schedule — no Handoff/Processing Date at accept+3d: "pick a date".
//   invoice  — no final invoice at accept+7d: "send the final invoice".
export type ChaseKind = 'confirm' | 'schedule' | 'invoice';

export interface ChaseCandidate {
  referralId: string;
  kind: ChaseKind;
  /** Escalation tier — meaningful for 'confirm'; new kinds always report 1. */
  tier: ChaseTier;
  /**
   * 'confirm': whole days past the due date. 'schedule'/'invoice': whole days
   * since Rancher Accepted At (their urgency measure).
   */
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

// No re-send within this window, regardless of tier/kind.
export const COOLDOWN_HOURS = 48;

// Never more than this many chase touches per referral, ever (all kinds).
export const MAX_LIFETIME_CHASES = 3;

// When a referral has no Handoff Date and no Processing Date, due date =
// Rancher Accepted At + this many days. Wave 2: dropped 30 → 14 (30d + the
// T+2d tier-1 lag meant the first "confirm?" nudge landed at accept+32d).
// Overridable via FULFILLMENT_CHASE_FALLBACK_DAYS in the route.
export const DEFAULT_FALLBACK_DAYS = 14;

// 'schedule' kind: nudge the rancher to pick a date once the deal has sat
// accepted this many days with no Handoff Date and no Processing Date.
export const SCHEDULE_NUDGE_AFTER_DAYS = 3;

// 'invoice' kind: nudge once the deal has sat accepted this many days with no
// final invoice sent (and money not otherwise confirmed). Max 2 touches —
// enforced via the shared Count ladder (fires only while Count ≤ 1).
export const INVOICE_NUDGE_AFTER_DAYS = 7;
export const INVOICE_NUDGE_MAX = 2;

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

// Tolerates both the plain-string and Airtable {name} object read shapes
// (same read as app/api/rancher/dashboard).
function isRancherAddedLead(ref: Record<string, any>): boolean {
  const raw = ref['Referral Source'];
  const s = String((raw as any)?.name || raw || '');
  return s.trim() === 'rancher-added';
}

const KIND_PRIORITY: Record<ChaseKind, number> = { confirm: 0, invoice: 1, schedule: 2 };

/**
 * Select the referrals due for a fulfillment chase, with their kind + tier.
 *
 * `referrals` are raw Airtable Referrals rows (flattened fields, as returned
 * by getAllRecords). The route pre-filters on long-standing fields only
 * ({Deposit Paid At}, {Rancher Accepted At}, {Status}); every check that
 * touches a possibly-missing field (Fulfillment Confirmed At, Fulfillment
 * Status, Handoff Date, the chase stamps) happens HERE in JS, where an absent
 * field is just `undefined` — the {Refunded At} lesson from
 * deposit-accept-sla.
 *
 * At most ONE candidate per referral per run. Returns confirm candidates
 * first (most-overdue first), then invoice, then schedule — so a per-run cap
 * (MAX_PER_RUN) always reaches the worst cases.
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
    const accepted = parseMs(ref['Rancher Accepted At']);
    if (accepted === null) continue; // no clock derivable for any kind

    // Dead deals. The formula excludes 'Closed Lost'; 'refunded' is
    // belt-and-braces for any drifted/legacy status value.
    const status = String(ref['Status'] || '').toLowerCase();
    if (status === 'closed lost' || status === 'refunded') continue;

    // Confirmed via EITHER path: the legacy binary confirm
    // (/api/rancher/fulfillment/confirm) or the richer tracker. Suppresses
    // the confirm + schedule kinds (nothing left to schedule/confirm).
    const confirmed =
      !!ref['Fulfillment Confirmed At'] ||
      String(ref[FULFILLMENT_FIELDS.status] || '').toLowerCase() === 'fulfilled';

    // Shared guards across every kind ------------------------------------
    // Lifetime cap.
    const count = Number(ref[CHASE_FIELDS.count]) || 0;
    if (count >= MAX_LIFETIME_CHASES) continue;

    // Cooldown — never two sends within 48h, across kinds.
    const lastSent = parseMs(ref[CHASE_FIELDS.lastSentAt]);
    if (lastSent !== null && now - lastSent < COOLDOWN_HOURS * 60 * 60 * 1000) continue;

    const daysSinceAccept = Math.floor((now - accepted) / DAY_MS);
    const handoffMs = parseMs(ref[FULFILLMENT_FIELDS.handoffDate]);
    const processingMs = parseMs(ref[FULFILLMENT_FIELDS.processingDate]);
    const rancherAdded = isRancherAddedLead(ref);

    // ── Kind 1: confirm (due date passed, unconfirmed) ────────────────────
    if (!confirmed) {
      // Due date: Handoff Date (buyer-facing) > Processing Date > accept +
      // fallback window.
      const due = handoffMs ?? processingMs ?? accepted + fallbackDays * DAY_MS;
      const daysPastDue = Math.floor((now - due) / DAY_MS);
      const tier = tierForDays(daysPastDue);
      // One send per tier: count is the highest tier already sent (the new
      // kinds' touches also climb this ladder — deliberate: a rancher who
      // already got schedule/invoice asks escalates, never repeats).
      if (tier !== null && tier > count) {
        out.push({ referralId: String(ref.id), kind: 'confirm', tier, daysPastDue });
        continue;
      }
    }

    // ── Kind 2: invoice (accepted ≥7d, no final invoice, money unconfirmed) ──
    // #511: never touch the rancher's own CRM leads. 'Closed Won' means the
    // close already happened (collect-balance UI owns stragglers) — skip.
    if (
      !rancherAdded &&
      status !== 'closed won' &&
      daysSinceAccept >= INVOICE_NUDGE_AFTER_DAYS &&
      !ref['Final Invoice Sent At'] &&
      !ref['Final Paid At'] &&
      !ref['Payment Confirmed At'] &&
      count < INVOICE_NUDGE_MAX
    ) {
      out.push({ referralId: String(ref.id), kind: 'invoice', tier: 1, daysPastDue: daysSinceAccept });
      continue;
    }

    // ── Kind 3: schedule (accepted ≥3d, no dates at all) ──────────────────
    // Fires at most once ever (Count 0 only). #511 exclusion applies.
    if (
      !rancherAdded &&
      !confirmed &&
      status !== 'closed won' &&
      daysSinceAccept >= SCHEDULE_NUDGE_AFTER_DAYS &&
      handoffMs === null &&
      processingMs === null &&
      count === 0
    ) {
      out.push({ referralId: String(ref.id), kind: 'schedule', tier: 1, daysPastDue: daysSinceAccept });
    }
  }

  // Confirm first (most overdue first), then invoice, then schedule.
  out.sort((a, b) => {
    const p = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
    if (p !== 0) return p;
    return b.daysPastDue - a.daysPastDue;
  });
  return out;
}
