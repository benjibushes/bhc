// lib/cronReadFilters.ts
//
// Server-side filterByFormula builders for the full-table-scan crons
// (scale-ladder item #3). Each cron used to `getAllRecords(CONSUMERS|
// REFERRALS)` with NO filter, then narrow in JS — pulling all 24+ Airtable
// pages every run and burning the shared 5 req/s base budget as volume grows.
//
// These formulas push the CHEAPEST SAFE SUBSET of each cron's JS predicate
// into Airtable so only candidate rows ship. The rule for every builder here:
//   - The formula MUST be a SUPERSET of (or equal to) the JS filter that
//     stays in the cron. It NEVER drops a row the cron would have processed.
//     The JS filter remains the exact belt (defense in depth).
//   - Reference ONLY long-standing fields confirmed to exist on the table:
//     {Status} / {Buyer Stage} / {Unsubscribed}. A formula referencing a
//     field that doesn't exist ERRORS the whole query — callers wrap the
//     filtered read and fall back to the unfiltered scan on
//     isInvalidFilterFormulaError (mirrors app/api/rancher/dashboard).
//
// Pure string builders only — no Airtable calls, no runtime deps — so the
// formula strings + their superset guarantees can be unit-tested directly
// (lib/cronReadFilters.test.ts pins both).

import { HELD_REFERRAL_STATUSES } from './capacityCount';

// Build an OR({Status} = "A", {Status} = "B", ...) clause from a status list.
// Statuses here are code-owned constants (never user input), but we keep the
// values quote-free by construction; if that ever changes, route through
// escapeAirtableValue. Empty list → returns null (caller skips the filter).
export function statusOrFormula(statuses: readonly string[]): string | null {
  const list = statuses.filter((s) => typeof s === 'string' && s.length > 0);
  if (list.length === 0) return null;
  return `OR(${list.map((s) => `{Status} = "${s}"`).join(', ')})`;
}

// ── Referrals: held-slot reconciliation (capacity-drift-check, batch-approve)
// Both crons bucket EVERY held-status referral by rancher id to recompute the
// capacity counter. The canonical held set is HELD_REFERRAL_STATUSES. A
// formula equal to that set is an exact (=) match for the JS predicate
// (`HELD_REFERRAL_STATUSES.has(ref['Status'])`), so it can never drop a
// counted row. Sorted for a stable, test-pinnable string.
export const HELD_REFERRAL_STATUS_LIST: readonly string[] = Array.from(
  HELD_REFERRAL_STATUSES,
).sort();

export function heldReferralsFormula(): string {
  // HELD_REFERRAL_STATUSES is always non-empty (5 statuses) → never null.
  return statusOrFormula(HELD_REFERRAL_STATUS_LIST)!;
}

// ── Referrals: active-deal lookup (stuck-buyer-recovery)
// stuck-buyer-recovery keeps rows where isActiveDealReferral(ref) is true =
// any HELD status OR ('Pending Approval' AND a linked rancher). The formula is
// a SUPERSET: HELD statuses + ALL 'Pending Approval' rows (the linked-rancher
// refinement stays in JS — a link-array check can't live safely in a formula).
// Superset holds because {every row the JS keeps} ⊆ {HELD ∪ Pending Approval}.
export const ACTIVE_DEAL_STATUS_LIST: readonly string[] = [
  ...HELD_REFERRAL_STATUS_LIST,
  'Pending Approval',
];

export function activeDealReferralsFormula(): string {
  return statusOrFormula(ACTIVE_DEAL_STATUS_LIST)!;
}

// ── Referrals: email-sequences buyer→rancher-name maps (line ~251)
// The JS keeps rows whose Status is Closed Won (closed-won map) OR one of
// Intro Sent / Rancher Contacted / Negotiation / Pending Approval (active
// map). The formula is exactly that status union — an equal set, not just a
// superset — so no mapped row is dropped.
export const SEQUENCE_RANCHER_MAP_STATUS_LIST: readonly string[] = [
  'Closed Won',
  'Intro Sent',
  'Rancher Contacted',
  'Negotiation',
  'Pending Approval',
];

export function sequenceRancherMapReferralsFormula(): string {
  return statusOrFormula(SEQUENCE_RANCHER_MAP_STATUS_LIST)!;
}

// (dailyDigestReferralsFormula removed Wave 1C 2026-08-01 — its sole consumer,
// the daily-digest cron, merged into daily-health-digest, which reads the
// full Referrals table for its pipeline counts.)

// ── Consumers: unsubscribed-email set (referral-chasup line ~45)
// chasup pulls consumers ONLY to build a Set of unsubscribed buyer emails
// (`c['Unsubscribed']` truthy). The formula returns exactly those rows.
// {Unsubscribed} is the long-standing suppression checkbox referenced across
// the codebase (send-scheduled isMailable, email lib, backer-monthly-letter).
export function unsubscribedConsumersFormula(): string {
  return '{Unsubscribed} = TRUE()';
}

// ── Consumers: mailable audience (send-scheduled line ~49)
// send-scheduled's isMailable drops Unsubscribed / Bounced / Complained rows;
// the audience token then narrows by Segment/State IN JS. The one dimension
// common to EVERY audience branch (consumers / consumers-beef / consumers-
// community / state:*) is the suppression drop — Segment/State can't be
// pushed down safely (consumers-community keeps blank-Segment rows). So the
// formula mirrors isMailable ONLY: a strict superset of every branch's kept
// set. All three fields are long-standing suppression checkboxes.
export function mailableConsumersFormula(): string {
  return (
    'AND(' +
    'NOT({Unsubscribed} = TRUE()), ' +
    'NOT({Bounced} = TRUE()), ' +
    'NOT({Complained} = TRUE())' +
    ')'
  );
}

// ── Consumers: stuck-buyer-recovery candidate pool (line ~55)
// The cron keeps consumers at Buyer Stage = 'READY' (then further narrows by
// Ready to Buy / Segment / Status / cooldown in JS). {Buyer Stage} is a
// long-standing field the cron already reads. Formula = the single required
// stage → strict superset of the kept set.
export function readyStuckBuyersFormula(): string {
  return '{Buyer Stage} = "READY"';
}
