// lib/depositSla.ts
//
// Flawless-handoff (2026-06-27): pure eligibility selector for the
// deposit-accept-sla safety-net cron (app/api/cron/deposit-accept-sla).
//
// A paid deposit that the rancher never accepts is the worst silent failure on
// the platform: the buyer paid, is waiting for a call, and nothing happens. The
// cron re-pings the rancher + escalates to Ben. This module is the dependency-
// free decision logic so it unit-tests without Airtable.

export const DEFAULT_SLA_HOURS = 4;
// Re-ping at most once per ~day. 20h (not 24h) so a daily-ish cron cadence
// doesn't skip a day due to minor drift, while still never double-pinging
// within the same business day.
export const DEFAULT_REPING_COOLDOWN_HOURS = 20;

// Terminal / already-resolved statuses that must never be re-pinged.
export const SLA_EXCLUDED_STATUSES: ReadonlySet<string> = new Set([
  'Closed Won',
  'Closed Lost',
]);

export interface SlaReferralLike {
  id?: string;
  Status?: unknown;
  'Deposit Paid At'?: unknown;
  'Rancher Accepted At'?: unknown;
  'Rancher Re-pinged At'?: unknown;
}

export interface SlaOptions {
  /** Hours since deposit landed before we re-ping. Default 4. */
  slaHours?: number;
  /** Min hours between re-pings for the same referral. Default 20. */
  repingCooldownHours?: number;
  /** Injectable clock for tests. Default Date.now(). */
  now?: number;
}

function toMs(v: unknown): number {
  if (!v) return 0;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Is this single referral eligible for an SLA re-ping right now?
 *
 * Eligible when ALL hold:
 *   1. Deposit Paid At is set (a real deposit landed).
 *   2. Rancher Accepted At is NOT set (rancher hasn't locked the slot).
 *   3. Status is not terminal (Closed Won / Closed Lost).
 *   4. The deposit landed more than `slaHours` ago.
 *   5. Not re-pinged within the last `repingCooldownHours` (dedupe).
 */
export function isSlaEligible(ref: SlaReferralLike, opts: SlaOptions = {}): boolean {
  const slaHours = opts.slaHours ?? DEFAULT_SLA_HOURS;
  const cooldownHours = opts.repingCooldownHours ?? DEFAULT_REPING_COOLDOWN_HOURS;
  const now = opts.now ?? Date.now();
  const HOUR = 3_600_000;

  const depositPaidAt = toMs(ref['Deposit Paid At']);
  if (!depositPaidAt) return false;

  // Rancher already accepted — slot locked, nothing to chase.
  if (ref['Rancher Accepted At']) return false;

  const status = String(ref.Status || '');
  if (SLA_EXCLUDED_STATUSES.has(status)) return false;

  // Not old enough yet.
  if (now - depositPaidAt < slaHours * HOUR) return false;

  // Already re-pinged recently — wait out the cooldown.
  const lastReping = toMs(ref['Rancher Re-pinged At']);
  if (lastReping && now - lastReping < cooldownHours * HOUR) return false;

  return true;
}

/**
 * Filter a list of referrals to the SLA-eligible ones. Pure — the cron does the
 * Airtable read then hands the rows here.
 */
export function selectSlaEligible<T extends SlaReferralLike>(refs: T[], opts: SlaOptions = {}): T[] {
  return (refs || []).filter((r) => isSlaEligible(r, opts));
}

/** Whole hours since the deposit landed (for the alert copy). */
export function hoursSinceDeposit(ref: SlaReferralLike, now: number = Date.now()): number {
  const depositPaidAt = toMs(ref['Deposit Paid At']);
  if (!depositPaidAt) return 0;
  return Math.floor((now - depositPaidAt) / 3_600_000);
}
