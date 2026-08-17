// lib/depositSla.ts
//
// Flawless-handoff (2026-06-27): pure eligibility selector for the
// deposit-accept-sla safety-net cron (app/api/cron/deposit-accept-sla).
//
// A paid deposit that the rancher never accepts is the worst silent failure on
// the platform: the buyer paid, is waiting for a call, and nothing happens. The
// cron re-pings the rancher + escalates to Ben. This module is the dependency-
// free decision logic so it unit-tests without Airtable.
//
// CONNECT RAIL ONLY — the re-ping half (2026-08-17). "Rancher Accepted At" is
// Connect machinery: the rancher taps Accept Slot in a dashboard. A BROKER-rail
// sale is a represented ranch with no dashboard, no login and no Accept button,
// so that field is empty forever — every broker sale matched the cron's Airtable
// formula and got up to 3 emails telling an off-platform rancher to tap
// something that does not exist, plus a buyer note whose premise ("they haven't
// confirmed your slot") is machinery this rail doesn't have. isSlaEligible now
// refuses broker rows outright. The 72h operator escalation deliberately still
// fires for them — see isEscalationDue.
//
// The two brokerRail imports are the only ones here; both modules are hermetic
// (brokerRail imports lib/pricing and nothing else, commission imports
// brokerRail and nothing else), so this stays Airtable-free and unit-testable.

import { isBrokerRancher, BROKER_PAYMENT_TYPE } from './brokerRail';
import { isBrokerReferralRow } from './commission';

export const DEFAULT_SLA_HOURS = 4;
// Re-ping at most once per ~day. 20h (not 24h) so a daily-ish cron cadence
// doesn't skip a day due to minor drift, while still never double-pinging
// within the same business day.
export const DEFAULT_REPING_COOLDOWN_HOURS = 20;
// Email-hygiene 2026-08-02: the re-ping used to repeat every ~20h FOREVER on
// an unresponsive rancher. Cap it at 3 rancher pings total, derived purely
// from time-since-deposit (no new Airtable fields): with slaHours=4 and a 20h
// cooldown the pings land at ~4h / ~24h / ~44h, and the window closes at
// slaHours + 3×cooldown = 64h — the 4th ping (~64h) can never fire.
export const DEFAULT_MAX_RANCHER_PINGS = 3;
// After this many hours unaccepted, the machine stops emailing the rancher
// and hands the deal to a human: ONE loud operator escalation per referral
// (cron-side claimOnce + sendOperatorSignal dedupe).
export const ESCALATION_AFTER_HOURS = 72;

/**
 * Hours after Deposit Paid At beyond which NO further rancher re-ping fires.
 * Time-derived ping cap: first ping ≥ slaHours, each subsequent ping ≥
 * cooldown later, so age < slaHours + maxPings×cooldown bounds the total
 * pings at maxPings even under hourly-cron drift.
 */
export function repingWindowHours(
  slaHours: number = DEFAULT_SLA_HOURS,
  cooldownHours: number = DEFAULT_REPING_COOLDOWN_HOURS,
  maxPings: number = DEFAULT_MAX_RANCHER_PINGS,
): number {
  return slaHours + maxPings * cooldownHours;
}

// Terminal / already-resolved statuses that must never be re-pinged.
// Refunded / Cancelled / Expired added (review fix): a refund/cancel/expire
// resolves the deal — re-pinging the rancher about it would be wrong.
export const SLA_EXCLUDED_STATUSES: ReadonlySet<string> = new Set([
  'Closed Won',
  'Closed Lost',
  'Refunded',
  'Cancelled',
  'Canceled', // tolerate both spellings of the singleSelect option
  'Expired',
]);

// Payments-row shape we care about for refund/dispute exclusion. The cron
// attaches the linked Payments row as `__payment` so this module stays pure.
export interface SlaPaymentLike {
  'Refunded At'?: unknown;
  Status?: unknown;            // 'refunded' on a full refund
  'Dispute Status'?: unknown;  // any non-empty value = active/closed dispute
  // Ledger-side rail marker — 'broker_deposit' on the broker rail
  // (lib/contracts/payments recordBrokerDeposit). Present on every settled
  // broker row, so the rail is readable without a second Airtable lookup.
  Type?: unknown;
}

export interface SlaReferralLike {
  id?: string;
  Status?: unknown;
  'Deposit Paid At'?: unknown;
  'Rancher Accepted At'?: unknown;
  'Rancher Re-pinged At'?: unknown;
  // Referral-side refund signal — only stamped on the Closed-Won refund path
  // (lib/contracts/payments.ts::restoreReferralAfterRefund). Checked for
  // defense-in-depth; the authoritative signal for Awaiting-Payment refunds
  // (the blocker case) is on __payment below.
  'Refunded At'?: unknown;
  'Dispute Status'?: unknown;
  // Linked Payments row, attached by the cron. THIS is where a refund of an
  // Awaiting-Payment deposit (and every dispute) is recorded — the Referral
  // itself is NOT flipped in those cases, so without this the cron would re-ping
  // a refunded/disputed deposit forever.
  __payment?: SlaPaymentLike | null;
  // Referral-side broker marker, stamped at referral creation
  // (lib/brokerReferral) — present before, during and after payment.
  'Match Type'?: unknown;
  // Linked Ranchers row, attached by the cron. The AUTHORITATIVE rail signal
  // (`Broker Rail` checkbox); the two markers above are belts for the case
  // where the record could not be read.
  __rancher?: unknown;
}

/**
 * Is this SLA candidate a BROKER-rail sale?
 *
 * Three independent signals, any one of which is conclusive — a Connect
 * referral carries none of them:
 *   1. the linked rancher's `Broker Rail` checkbox (authoritative — the same
 *      strict parse every other broker surface uses);
 *   2. the linked Payments row's `Type` = 'broker_deposit' (written at settle);
 *   3. the referral's `Match Type` = 'Broker — Deposit' (written at mint).
 *
 * OR rather than AND on purpose: signals 2 and 3 keep the exclusion working
 * when the rancher record is unreadable, and a false "this is broker" would
 * merely skip an email while a false "this is Connect" emails a represented
 * ranch instructions for a dashboard they do not have.
 */
export function isBrokerRailReferral(ref: SlaReferralLike): boolean {
  if (isBrokerRancher(ref.__rancher)) return true;
  if (String(ref.__payment?.Type || '').trim() === BROKER_PAYMENT_TYPE) return true;
  return isBrokerReferralRow(ref);
}

/**
 * Has this deposit been refunded or disputed? Checks BOTH the Referral (Closed
 * Won refund path) and its linked Payments row (Awaiting-Payment refunds + all
 * disputes, which only ever land on the Payments row).
 */
export function isRefundedOrDisputed(ref: SlaReferralLike): boolean {
  // Referral-side (Closed Won refund path / defense-in-depth).
  if (ref['Refunded At']) return true;
  if (String(ref['Dispute Status'] || '').trim()) return true;

  // Payments-side — the authoritative signal for the blocker case.
  const p = ref.__payment;
  if (p) {
    if (p['Refunded At']) return true;                       // full OR partial refund stamps this
    if (String(p.Status || '').toLowerCase() === 'refunded') return true;
    if (String(p['Dispute Status'] || '').trim()) return true;
  }
  return false;
}

export interface SlaOptions {
  /** Hours since deposit landed before we re-ping. Default 4. */
  slaHours?: number;
  /** Min hours between re-pings for the same referral. Default 20. */
  repingCooldownHours?: number;
  /** Max rancher pings total (time-derived — see repingWindowHours). Default 3. */
  maxRancherPings?: number;
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
 *   3. Status is not terminal (Closed Won / Closed Lost / Refunded / etc).
 *   4. The deposit was NOT refunded or disputed (Referral OR Payments row).
 *   5. The deposit landed more than `slaHours` ago.
 *   6. Not re-pinged within the last `repingCooldownHours` (dedupe).
 *   7. Still inside the re-ping window (max ~3 pings total — after that the
 *      rancher goes quiet and the operator escalation takes over).
 *   8. The referral is on the CONNECT rail. A broker sale can never satisfy
 *      condition 2 (nothing writes Rancher Accepted At there), so without this
 *      it would qualify forever — see the module header.
 */
export function isSlaEligible(ref: SlaReferralLike, opts: SlaOptions = {}): boolean {
  const slaHours = opts.slaHours ?? DEFAULT_SLA_HOURS;
  const cooldownHours = opts.repingCooldownHours ?? DEFAULT_REPING_COOLDOWN_HOURS;
  const maxPings = opts.maxRancherPings ?? DEFAULT_MAX_RANCHER_PINGS;
  const now = opts.now ?? Date.now();
  const HOUR = 3_600_000;

  const depositPaidAt = toMs(ref['Deposit Paid At']);
  if (!depositPaidAt) return false;

  // Rancher already accepted — slot locked, nothing to chase.
  if (ref['Rancher Accepted At']) return false;

  // BROKER RAIL — this whole rail (re-ping copy, "tap Accept Slot", the buyer
  // delay note) describes Connect machinery a represented ranch does not have.
  // Chased by the operator escalation instead.
  if (isBrokerRailReferral(ref)) return false;

  const status = String(ref.Status || '');
  if (SLA_EXCLUDED_STATUSES.has(status)) return false;

  // Refunded/disputed — resolved, never re-ping. This is the BLOCKER fix: an
  // Awaiting-Payment deposit refunded in the NRD window keeps Deposit Paid At +
  // status Awaiting Payment (restoreReferralAfterRefund only reverts Closed
  // Won), so without this it would re-ping the rancher forever.
  if (isRefundedOrDisputed(ref)) return false;

  const age = now - depositPaidAt;

  // Not old enough yet.
  if (age < slaHours * HOUR) return false;

  // Ping cap (email-hygiene 2026-08-02): past the re-ping window the rancher
  // has had their ~3 pings — emailing them again is noise. The operator
  // escalation (isEscalationDue) owns the deal from here.
  if (age >= repingWindowHours(slaHours, cooldownHours, maxPings) * HOUR) return false;

  // Already re-pinged recently — wait out the cooldown.
  const lastReping = toMs(ref['Rancher Re-pinged At']);
  if (lastReping && now - lastReping < cooldownHours * HOUR) return false;

  return true;
}

export interface EscalationOptions {
  /** Hours unaccepted before the one-shot operator escalation. Default 72. */
  escalationAfterHours?: number;
  /** Injectable clock for tests. Default Date.now(). */
  now?: number;
}

/**
 * Past ESCALATION_AFTER_HOURS unaccepted, the machine stops emailing the
 * rancher and a HUMAN takes over: this predicate says "this referral needs the
 * one loud operator escalation". Same hard exclusions as the re-ping (terminal
 * status, refunded/disputed, accepted) — the cron dedupes the actual send per
 * referral (claimOnce + sendOperatorSignal dedupeKey), so this returning true
 * on every run after 72h is safe by design.
 *
 * BROKER ROWS ARE DELIBERATELY NOT EXCLUDED (2026-08-17). They are excluded
 * from the re-ping (isSlaEligible) because that rail's copy is Connect-only,
 * but the escalation is the opposite case: on the broker rail NOTHING in the
 * system can tell us whether the ranch ever called the buyer — there is no
 * Accept, no thread, no payout event — so a one-shot "did the ranch make
 * contact?" prompt to a human is the only backstop that exists, and dropping it
 * would leave broker sales with no safety net at all. It is operator-facing,
 * fires once per referral ever, and the cron renders broker-correct copy for it
 * (the buyer and the ranch are never emailed by this path).
 */
export function isEscalationDue(ref: SlaReferralLike, opts: EscalationOptions = {}): boolean {
  const afterHours = opts.escalationAfterHours ?? ESCALATION_AFTER_HOURS;
  const now = opts.now ?? Date.now();

  const depositPaidAt = toMs(ref['Deposit Paid At']);
  if (!depositPaidAt) return false;
  if (ref['Rancher Accepted At']) return false;
  if (SLA_EXCLUDED_STATUSES.has(String(ref.Status || ''))) return false;
  if (isRefundedOrDisputed(ref)) return false;
  return now - depositPaidAt >= afterHours * 3_600_000;
}

/** Filter a list of referrals to the escalation-due ones. Pure. */
export function selectEscalationDue<T extends SlaReferralLike>(
  refs: T[],
  opts: EscalationOptions = {},
): T[] {
  return (refs || []).filter((r) => isEscalationDue(r, opts));
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
