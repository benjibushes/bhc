// lib/pipelineSla.ts
//
// THE PIPELINE-SLA MATRIX — every open deal stage gets a clock, an owner, and
// an escalation. Pure selectors for app/api/cron/pipeline-sla/route.ts.
//
// THE FAILURES THIS CLOSES (all real, all 2026):
//   • a PAID deposit sat at 'Slot Locked' for 24 days and nobody noticed —
//     no cron owned that stage once the rancher had tapped Accept.
//   • referrals sat at 'Negotiation' since April — the only Negotiation clock
//     was referral-stale-expiry's 42d TERMINAL Dormant flip (gated, and
//     blocked outright by any deposit signal), so a deal could rot for months
//     before anything even attempted a human handoff.
//   • paused ranchers stay paused forever — "machine pauses itself
//     automatically, resumes itself never" (4 writers of Paused, 0 reverse
//     outside the narrow migration-deadline auto-resume).
//
// ESCALATION ≠ EXPIRY. referral-stale-expiry ends deals (Dormant). This rail
// never ends anything: it stamps the row onto the human dial list ('Stuck
// Escalated At'/'Stuck Escalated Bucket' — the same plumbing the #608
// applied-chase handoff uses on Ranchers) and, for the money-loud class,
// fires ONE operator signal. Zero buyer/rancher sends, ever.
//
// ── THE MATRIX (open Referrals stages) ──────────────────────────────────────
//
//   stage               clock basis                          maxAge  escalation
//   Rancher Contacted   newest activity stamp (see below)     14d    dial-list
//   Negotiation         newest activity stamp                  7d    dial-list
//   Slot Locked         'Rancher Accepted At' (the accept      5d    LOUD + dial-list
//                       write flips Status→Slot Locked and
//                       stamps this atomically — accept
//                       route :145; refunds null both)
//   In Progress         newest activity stamp                 21d    dial-list
//
// CLOCK BASIS: Referrals has NO per-stage transition timestamps except the
// Slot Locked ↔ 'Rancher Accepted At' pair (deal stamp map,
// lib/deal/states.ts:47-52 — INTRO_SENT→Intro Sent At, SLOT_LOCKED→Rancher
// Accepted At, CLOSED_WON→Closed At; nothing stamps Negotiation / Rancher
// Contacted / In Progress). So every other stage falls back to the newest of
// the row's known dated stamps — Last Rancher Activity At · Last Buyer
// Activity At · Intro Sent At · Last Chased At · Rancher Accepted At ·
// _createdTime — i.e. "days since ANYTHING last happened on this deal", the
// same silence measure lib/staleHolds uses (plus Last Chased At, so an
// operator chase/dismiss inside the window counts as the deal being worked
// and resets the clock). A row with NO parseable stamp at all is skipped —
// never escalate on a guessed age (the stuck-referral-reaper rule).
//
// ── COVERED ELSEWHERE — (stage, clock) pairs EXCLUDED from this matrix ─────
// Read before adding a stage; duplicating a clock double-pings the operator.
//
//   'Pending Approval'  — stuck-referral-reaper (daily 16:50 UTC) reaps
//                         Approval Status='Pending Rancher Response' >5d;
//                         referral-stale-expiry tier 2 releases the buyer at
//                         ⅓×base (7d). Both already end in an operator card.
//   'Pending' (legacy)  — normalized to 'Pending Approval' every run by
//                         stuck-referral-reaper step 1; never a real stage.
//   'Intro Sent'        — first-touch-sla owns it wall-to-wall: 48h rancher
//                         nudge + 96h Telegram escalation, cross-throttled
//                         with referral-chasup L2a; stale-expiry tier 1 is
//                         the 21d terminal net.
//   'Awaiting Payment'  — the deepest-covered stage on the platform:
//                         deposit-watchdog (invite-never-sent >2h + balk
//                         pass, hourly), deposit-request-nudge (sent-unpaid
//                         chase), awaiting-payment-nudge, deposit-accept-sla
//                         (PAID + accept missing: re-ping ladder + 72h loud
//                         escalation), final-invoice-dunning, stale-expiry
//                         tier 3 (unreachable release). No room for a clock
//                         that isn't a duplicate.
//   Closed Won / Closed Lost / Refunded — terminal; no clock by definition.
//   'Dormant'           — the RELEASED state stale-expiry writes; recovery is
//                         owned by re-warm-cohort / loss-recovery.
//   'Waitlisted'        — parked by design until supply exists; the
//                         waiting-activation rail owns re-activation.
//   'Rejected'          — terminal operator decision; nothing to chase.
//
// WHY 'Slot Locked' STILL NEEDS A CLOCK despite fulfillment-chase:
// fulfillment-chase only sees rows with BOTH 'Deposit Paid At' AND 'Rancher
// Accepted At', and its shared 3-lifetime-touch ladder goes PERMANENTLY
// quiet after tier 3 (due+8d) — after that, a Slot Locked deal is once again
// a stage with no owner. This clock is the belt that never goes quiet: it
// re-escalates every RE_ESCALATE_COOLDOWN_DAYS for as long as the row sits
// in the stage. It sends no email — stamp + loud signal only — so it can
// never stack touches on fulfillment-chase's rancher sends.
//
// WHY 'Rancher Contacted' AT 14d despite the 21d reaper: stale-expiry's 21d
// Dormant flip is (a) gated behind STALE_HOLD_EXPIRY_ENABLED, (b) blocked by
// any deposit signal, and (c) an ENDING, not a handoff. 14d puts a human on
// the deal a week before the machine gives up on it — belt over the reaper.
//
// PURE: no I/O, no Date.now() (callers pass `now`), no input mutation.

import { isReferralOnHold } from './referralHold';
import { isSyntheticTestEmail } from './demandRouter';

// ── Tuning constants ────────────────────────────────────────────────────────

/** Per-run ceiling across BOTH passes (referral escalations + paused
 * reviews) — the first live sweep over months of backlog drains over days,
 * not in one operator-flooding blast. */
export const PIPELINE_SLA_MAX_PER_RUN = 25;

/** A row already stamped 'Stuck Escalated At' inside this window is NEVER
 * re-escalated — the human list has it; re-stamping would churn the queue's
 * days-stuck ordering and re-fire loud signals at a deal Ben already knows
 * about. Past the window the stage is STILL wrong, so it escalates again. */
export const RE_ESCALATE_COOLDOWN_DAYS = 14;

/** Rancher paused-review: Active Status='Paused' with pause evidence older
 * than this gets a dial-list entry; re-escalates at most every 30d. */
export const PAUSED_REVIEW_DAYS = 30;
export const PAUSED_REVIEW_BUCKET = 'paused-review';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Field names (the Airtable boundary of this module) ──────────────────────
//
// On RANCHERS both fields EXIST (written daily by onboarding-stuck /
// rancher-followup / applied-chase — verified against the live schema
// 2026-07-25). On REFERRALS they are NEW — lib/airtable's updateRecord
// auto-strips unknown fields (with a per-field operator alert) and the cron
// verifies persistence and aborts (deposit-watchdog pattern), so a missing
// field degrades loudly, never into a silent re-escalation loop. BEN: create
// both on Referrals before flipping PIPELINE_SLA_ENABLED live —
//   'Stuck Escalated At'     — dateTime
//   'Stuck Escalated Bucket' — singleLineText (or singleSelect carrying every
//                              STAGE_SLA_MATRIX bucket value)

export const STUCK_ESCALATED_AT_FIELD = 'Stuck Escalated At';
export const STUCK_ESCALATED_BUCKET_FIELD = 'Stuck Escalated Bucket';

// ── Types ───────────────────────────────────────────────────────────────────

export type PipelineSlaMode = 'off' | 'dry-run' | 'live';

/** 'dial-list' = stamp only (the row surfaces on /admin/today); 'loud' =
 * stamp + ONE sendOperatorSignal (urgency 'loud') — money may be collected. */
export type PipelineEscalationKind = 'dial-list' | 'loud';

export interface StageSla {
  /** Referrals.Status value this row clocks. */
  status: string;
  /** 'Stuck Escalated Bucket' value the escalation stamps. */
  bucket: string;
  /** Whole days in-stage (per the clock basis) before escalation. */
  maxAgeDays: number;
  escalation: PipelineEscalationKind;
  /** Which stamp anchors the clock — documentation surfaced in cards/tests. */
  basis: string;
}

/** THE stage-SLA matrix. One row per OPEN stage this rail owns — every
 * excluded stage is listed in the header with the cron that owns it. */
export const STAGE_SLA_MATRIX: readonly StageSla[] = [
  {
    status: 'Rancher Contacted',
    bucket: 'rancher-contacted',
    maxAgeDays: 14,
    escalation: 'dial-list',
    basis: 'newest activity stamp (no per-stage timestamp exists)',
  },
  {
    status: 'Negotiation',
    bucket: 'negotiation',
    maxAgeDays: 7,
    escalation: 'dial-list',
    basis: 'newest activity stamp (no per-stage timestamp exists)',
  },
  {
    status: 'Slot Locked',
    bucket: 'slot-locked',
    maxAgeDays: 5,
    escalation: 'loud',
    basis: "'Rancher Accepted At' (stamped atomically with the Slot Locked flip)",
  },
  {
    status: 'In Progress',
    bucket: 'in-progress',
    maxAgeDays: 21,
    escalation: 'dial-list',
    basis: 'newest activity stamp (no per-stage timestamp exists)',
  },
] as const;

const SLA_BY_STATUS: ReadonlyMap<string, StageSla> = new Map(
  STAGE_SLA_MATRIX.map((s) => [s.status, s]),
);

/** The subset of a Referrals row this module reads. Indexed loosely because
 * rows arrive as raw Airtable records; every read is defensive. */
export interface PipelineSlaRefRow {
  id: string;
  Status?: unknown;
  'Rancher Accepted At'?: unknown;
  'Last Rancher Activity At'?: unknown;
  'Last Buyer Activity At'?: unknown;
  'Intro Sent At'?: unknown;
  'Last Chased At'?: unknown;
  'Buyer Email'?: unknown;
  'Referral Source'?: unknown;
  'Hold Until'?: unknown;
  'Stuck Escalated At'?: unknown;
  _createdTime?: unknown;
}

export interface PipelineEscalation<T extends PipelineSlaRefRow = PipelineSlaRefRow> {
  ref: T;
  sla: StageSla;
  /** Whole days in-stage per the clock basis. */
  ageDays: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const str = (v: unknown): string => String(v ?? '').trim();

function parseMs(v: unknown): number {
  if (!v) return Number.NaN;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : Number.NaN;
}

export function pipelineSlaMode(raw: string | undefined): PipelineSlaMode {
  if (raw === 'true') return 'live';
  if (raw === 'dry-run') return 'dry-run';
  return 'off';
}

export function slaForStatus(status: string): StageSla | null {
  return SLA_BY_STATUS.get(str(status)) ?? null;
}

/**
 * Whole days the row has sat in its current stage, per the matrix's clock
 * basis. Slot Locked prefers 'Rancher Accepted At' (the one true per-stage
 * stamp); every stage falls back to the newest known dated stamp. Returns
 * null when NO stamp parses — never escalate on a guessed age.
 */
export function stageAgeDays(ref: PipelineSlaRefRow, now: number): number | null {
  if (str(ref.Status) === 'Slot Locked') {
    const accepted = parseMs(ref['Rancher Accepted At']);
    if (Number.isFinite(accepted)) {
      const days = Math.floor((now - accepted) / DAY_MS);
      return days >= 0 ? days : null;
    }
    // Drifted Slot Locked with no accept stamp — fall through to the shared
    // basis rather than going blind (deposit-accept-sla knows this drift
    // class exists: "any referral that drifted to Slot Locked without an
    // accept stamp").
  }
  const candidates = [
    ref['Last Rancher Activity At'],
    ref['Last Buyer Activity At'],
    ref['Intro Sent At'],
    ref['Last Chased At'],
    ref['Rancher Accepted At'],
    ref._createdTime,
  ];
  let newest = 0;
  for (const c of candidates) {
    const t = parseMs(c);
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  if (newest === 0) return null;
  const days = Math.floor((now - newest) / DAY_MS);
  return days >= 0 ? days : null;
}

/** Days since the row's last 'Stuck Escalated At' stamp; null when unstamped
 * or unparseable (unparseable reads as never-stamped — fail toward
 * escalating once rather than never). */
export function daysSinceEscalated(ref: { 'Stuck Escalated At'?: unknown }, now: number): number | null {
  const t = parseMs(ref[STUCK_ESCALATED_AT_FIELD as 'Stuck Escalated At']);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / DAY_MS);
}

/**
 * Pure per-row verdict: the escalation this row is due, or the skip reason.
 * Exposed (rather than only the selector) so the cron can build the same
 * skip-reason breakdown the Cron Runs row reports.
 */
export function pipelineSlaVerdict(
  ref: PipelineSlaRefRow,
  now: number,
): { escalation: PipelineEscalation } | { skip: string } {
  const sla = slaForStatus(str(ref.Status));
  if (!sla) return { skip: 'status-not-clocked' };

  // 'rancher-added' CRM leads are the rancher's OWN customers — BHC
  // automation stays out of that relationship (the staleHolds / chasup /
  // close-detector carve-out, #511).
  const src = ref['Referral Source'];
  const srcStr =
    src && typeof src === 'object' && 'name' in (src as any)
      ? String((src as any).name || '')
      : str(src);
  if (srcStr === 'rancher-added') return { skip: 'rancher-added' };

  // Operator ⏸️ Hold park — an explicit "come back to this later"; the same
  // guard referral-chasup / close-detector / stale-expiry apply. Fail-OPEN on
  // blank/corrupt values (lib/referralHold).
  if (isReferralOnHold(ref['Hold Until'], now)) return { skip: 'on-hold' };

  // Synthetic e2e rows never reach the operator's list.
  const email = str(ref['Buyer Email']).toLowerCase();
  if (email && isSyntheticTestEmail(email)) return { skip: 'synthetic' };

  const age = stageAgeDays(ref, now);
  if (age === null) return { skip: 'no-parseable-age' };
  if (age < sla.maxAgeDays) return { skip: 'inside-sla' };

  // Idempotence: stamped inside the cooldown → the human list already has it.
  const sinceEscalated = daysSinceEscalated(ref, now);
  if (sinceEscalated !== null && sinceEscalated < RE_ESCALATE_COOLDOWN_DAYS) {
    return { skip: 'already-escalated' };
  }

  return { escalation: { ref, sla, ageDays: age } };
}

/**
 * Select the escalations due this run, oldest-in-stage first (the longest-
 * ignored deal gets the first slot under the cap), id tiebreak so the order
 * is stable between runs.
 */
export function selectPipelineSlaEscalations<T extends PipelineSlaRefRow>(
  refs: readonly T[],
  now: number,
  cap: number = PIPELINE_SLA_MAX_PER_RUN,
): PipelineEscalation<T>[] {
  const due: PipelineEscalation<T>[] = [];
  for (const ref of refs) {
    const v = pipelineSlaVerdict(ref, now);
    if ('escalation' in v) due.push(v.escalation as PipelineEscalation<T>);
  }
  due.sort(
    (a, b) => b.ageDays - a.ageDays || String(a.ref.id).localeCompare(String(b.ref.id)),
  );
  return due.slice(0, Math.max(0, cap));
}

/** Skip-reason → count over the whole candidate pool, for Cron Runs. */
export function pipelineSlaSkipBreakdown(
  refs: readonly PipelineSlaRefRow[],
  now: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ref of refs) {
    const v = pipelineSlaVerdict(ref, now);
    const key = 'skip' in v ? v.skip : `due:${v.escalation.sla.bucket}`;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

// ── Rancher paused-review ───────────────────────────────────────────────────
//
// Active Status='Paused' has FOUR writers and no review loop (the
// pause-asymmetry finding): admin pause (stamps a '[PAUSED YYYY-MM-DD — …]'
// marker into Verification Notes), pilot completion (stamps 'Pilot Upsell
// Notified At' in the same write), migration-deadline (Migration
// Status='paused_overdue' at the 'Migration Deadline' date), and the
// rancher's own self-serve toggle (stamps NOTHING dated). Pause-age evidence,
// newest wins:
//   1. newest '[PAUSED YYYY-MM-DD…]' marker in Verification Notes
//   2. 'Pilot Upsell Notified At'
//   3. 'Migration Deadline', only when Migration Status='paused_overdue'
//      (the pause fires the day the deadline lapses)
// A Paused rancher with NO datable evidence is EXACTLY the forever-pause
// failure this rail exists for, so unknown age counts as review-due — the
// escalation is one dial-list stamp (no sends), and the 30d cooldown on
// 'Stuck Escalated At' bounds it to one entry per month worst-case.

export interface PausedRancherRow {
  id: string;
  'Active Status'?: unknown;
  'Verification Status'?: unknown;
  'Verification Notes'?: unknown;
  'Pilot Upsell Notified At'?: unknown;
  'Migration Status'?: unknown;
  'Migration Deadline'?: unknown;
  'Stuck Escalated At'?: unknown;
  'Stuck Escalated Bucket'?: unknown;
}

/** Unwrap an Airtable single-select that may arrive as {name} or a string. */
function sel(v: unknown): string {
  if (v && typeof v === 'object' && 'name' in (v as any)) return String((v as any).name ?? '');
  return str(v);
}

/** Newest pause-evidence timestamp (ms), or null when nothing dates it. */
export function pausedAtMs(r: PausedRancherRow): number | null {
  let newest = Number.NaN;
  const consider = (t: number) => {
    if (Number.isFinite(t) && (!Number.isFinite(newest) || t > newest)) newest = t;
  };
  const notes = str(r['Verification Notes']);
  for (const m of notes.matchAll(/\[PAUSED (\d{4}-\d{2}-\d{2})/g)) {
    consider(parseMs(m[1]));
  }
  consider(parseMs(r['Pilot Upsell Notified At']));
  if (sel(r['Migration Status']) === 'paused_overdue') {
    consider(parseMs(r['Migration Deadline']));
  }
  return Number.isFinite(newest) ? newest : null;
}

export interface PausedReviewDue {
  rancher: PausedRancherRow;
  /** Whole days paused per the evidence; null = undatable (still due). */
  pausedDays: number | null;
}

/**
 * Pure per-rancher verdict for the paused-review lane. Broker exclusion is
 * the CALLER's job (excludeBrokerRanchers — broker ranchers are deliberately
 * configured by Ben; a "re-review this pause" dial would be noise).
 */
export function pausedReviewVerdict(
  r: PausedRancherRow,
  now: number,
): { due: PausedReviewDue } | { skip: string } {
  if (sel(r['Active Status']) !== 'Paused') return { skip: 'not-paused' };
  // Self-serve account closure — never resurrect a closed account.
  if (sel(r['Verification Status']) === 'Removed') return { skip: 'removed' };

  const pausedMs = pausedAtMs(r);
  const pausedDays = pausedMs === null ? null : Math.floor((now - pausedMs) / DAY_MS);
  if (pausedDays !== null && pausedDays < PAUSED_REVIEW_DAYS) {
    return { skip: 'pause-too-fresh' };
  }

  // Re-escalate at most every PAUSED_REVIEW_DAYS. The stamp is SHARED with
  // the onboarding chase rails — respecting it regardless of bucket means a
  // rancher escalated by any rail inside the window is never double-listed.
  const since = daysSinceEscalated(r, now);
  if (since !== null && since < PAUSED_REVIEW_DAYS) return { skip: 'recently-escalated' };

  return { due: { rancher: r, pausedDays } };
}

/** Longest-paused first; undatable pauses (age unknown) sort LAST so rows
 * with proven 30d+ neglect beat "probably old" ones under the cap. */
export function selectPausedReviews<T extends PausedRancherRow>(
  ranchers: readonly T[],
  now: number,
  cap: number,
): Array<{ rancher: T; pausedDays: number | null }> {
  const due: Array<{ rancher: T; pausedDays: number | null }> = [];
  for (const r of ranchers) {
    const v = pausedReviewVerdict(r, now);
    if ('due' in v) due.push({ rancher: r, pausedDays: v.due.pausedDays });
  }
  due.sort((a, b) => {
    const ad = a.pausedDays ?? -1;
    const bd = b.pausedDays ?? -1;
    return bd - ad || String(a.rancher.id).localeCompare(String(b.rancher.id));
  });
  return due.slice(0, Math.max(0, cap));
}

/** Skip-reason breakdown over the PAUSED cohort only (callers pre-filter to
 * Active Status='Paused' — running it over all ranchers would drown the
 * breakdown in 'not-paused'). */
export function pausedReviewSkipBreakdown(
  ranchers: readonly PausedRancherRow[],
  now: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of ranchers) {
    if (sel(r['Active Status']) !== 'Paused') continue;
    const v = pausedReviewVerdict(r, now);
    const key = 'skip' in v ? `paused:${v.skip}` : 'paused:due';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}
