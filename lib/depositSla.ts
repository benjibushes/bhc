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
// and hands the deal to a human.
export const ESCALATION_AFTER_HOURS = 72;

// ── RE-ESCALATION (fulfillment audit P0-2, 2026-08-18) ─────────────────────
// The escalation used to be ONE-SHOT FOREVER: the cron took a claimOnce with a
// 365-day TTL (plus a 7-day sendOperatorSignal dedupe window), so after the
// single 72h alert the machine was permanently mute on that row. Combined with
// the re-ping window closing at ~64h (repingWindowHours above), a paid deposit
// whose ranch simply never answered got exactly ONE human-facing mention in
// its entire life, and then silence — with the buyer's money still collected.
//
// Now it re-surfaces on a cooldown, mirroring lib/pipelineSla's
// RE_ESCALATE_COOLDOWN_DAYS: a row escalated inside the window is left alone
// (the human list has it); past the window the money is STILL collected and
// the slot STILL unaccepted, so it escalates again — until it is accepted,
// refunded, or closed. Tighter than pipelineSla's 14d because this cohort has
// already taken the customer's money.
export const RE_ESCALATE_COOLDOWN_DAYS = 3;

/**
 * TTL (seconds) for the cron's Redis escalation claim. The claim IS the
 * durable "last escalated at" for this rail — Referrals has no free field for
 * a deposit-escalation stamp — so its TTL must equal the cooldown exactly,
 * or the cadence silently becomes whichever of the two is longer.
 */
export function escalationClaimTtlSec(
  cooldownDays: number = RE_ESCALATE_COOLDOWN_DAYS,
): number {
  return Math.round(cooldownDays * 24 * 60 * 60);
}

/**
 * Dedupe window for the escalation's operator signal. Deliberately SHORTER
 * than the cooldown: the claim is the throttle, and a signal dedupe window
 * that outlived it would swallow every re-escalation after the first (the
 * exact bug this fixes — the old window was 7d against a 365d claim).
 */
export function escalationDedupeWindowMs(
  cooldownDays: number = RE_ESCALATE_COOLDOWN_DAYS,
): number {
  return Math.max(1, Math.round(cooldownDays * 24 * 60 * 60 * 1000 - 3_600_000));
}

/**
 * Is a re-escalation due for a row we last escalated at `lastEscalatedAt`?
 *
 * `null`/blank/unparseable ⇒ never escalated ⇒ due (fail OPEN: an unreadable
 * timestamp on collected money must surface, not vanish).
 */
export function isReEscalationDue(
  lastEscalatedAt: unknown,
  now: number,
  cooldownDays: number = RE_ESCALATE_COOLDOWN_DAYS,
): boolean {
  const t = toMs(lastEscalatedAt);
  if (!t) return true;
  return now - t >= cooldownDays * 24 * 60 * 60 * 1000;
}

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
  'Refunded At'?: unknown;     // stamped on a PARTIAL refund too — never read alone
  Status?: unknown;            // 'refunded' on a full refund, and ONLY then
  'Dispute Status'?: unknown;  // Stripe dispute.status; only 'lost' returns the money
  // Amounts, used to recognise a full refund on a row whose Status write was
  // lost. Same precedence as lib/contracts/payments::markDepositRefunded.
  'Refunded Amount Cents'?: unknown;
  'Amount Cents'?: unknown;
  'Platform Fee Cents'?: unknown;
  'Total Charged Cents'?: unknown;
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

// ---------------------------------------------------------------------------
// REFUND / DISPUTE TRUTH (review fix B3, 2026-08-18)
// ---------------------------------------------------------------------------
//
// THE BUG THIS CLOSES. `Refunded At` on the Payments row was read as "this
// money is gone". It is not: markDepositRefunded (lib/contracts/payments.ts)
// stamps `Refunded At` on EVERY refund and only sets `Status: 'refunded'` when
// the refund is FULL. So a $1 goodwill refund against a $750 deposit — or an
// open chargeback, which merely means the buyer is contesting — silently
// deleted the whole obligation: the customer is still owed a side of beef and
// no surface says so. This goes live the moment PR #650 lands, which adds
// partial-refund support on the rail where the deposit IS 100% of revenue.
//
// The fix is two predicates instead of one question doing two jobs:
//   isMoneyReturnedToBuyer — did the buyer actually get their money back for
//     good (FULL refund, or a dispute we lost)? The ONLY thing allowed to
//     erase an obligation. New; used by lib/obligations.
//   isRefundedOrDisputed   — should automated OUTREACH pause? Any refund, any
//     dispute. UNCHANGED, because narrowing it would resume sends that the
//     send rails (lib/depositSla's own re-ping + escalation,
//     lib/reserveRecovery's buyer email/SMS) deliberately suppress today.
//     Read surfaces must not borrow a send rail's caution.

/** Total the buyer was actually charged. Mirrors markDepositRefunded exactly. */
function capturedCentsOf(p: SlaPaymentLike): number {
  const deposit = Number(p['Amount Cents'] || 0);
  const fee = Number(p['Platform Fee Cents'] || 0);
  const total = Number(p['Total Charged Cents'] || 0);
  return total > 0 ? total : (deposit + fee) || deposit;
}

/**
 * Stripe dispute statuses in which the money has left for good. `won` means we
 * KEPT the money (so the beef is still owed); every `*needs_response` /
 * `under_review` / `warning_*` value is a dispute still in flight, where the
 * obligation very much still stands.
 */
const DISPUTE_LOST_STATUSES: ReadonlySet<string> = new Set(['lost']);

/** Is a dispute recorded at all — in flight or settled, either way? */
function hasAnyDispute(v: unknown): boolean {
  return !!String(v || '').trim();
}

/**
 * Did the buyer get their money back for good — a genuinely FULL refund, or a
 * dispute we LOST?
 *
 * This is the only signal allowed to erase an obligation. A partial refund
 * leaves it standing, because a partly-refunded customer is still a customer
 * waiting on beef.
 */
export function isMoneyReturnedToBuyer(ref: SlaReferralLike): boolean {
  // Referral-side: refundReferralClearFields (lib/refundLifecycle) writes this
  // ONLY from restoreReferralAfterRefund, which payments.ts calls only when
  // isFullRefund — so a Referral-side stamp always means a full refund. (It
  // also nulls 'Deposit Paid At', so such a row rarely reaches here at all.)
  if (ref['Refunded At']) return true;
  if (DISPUTE_LOST_STATUSES.has(String(ref['Dispute Status'] || '').trim().toLowerCase())) {
    return true;
  }

  const p = ref.__payment;
  if (!p) return false;

  if (DISPUTE_LOST_STATUSES.has(String(p['Dispute Status'] || '').trim().toLowerCase())) {
    return true;
  }
  // AUTHORITATIVE full-refund signal. markDepositRefunded sets Status
  // 'refunded' on a full refund under EVERY schema — its old-schema fallback
  // write strips 'Refund Reason'/'Refunded Amount Cents' but keeps Status.
  if (String(p.Status || '').toLowerCase() === 'refunded') return true;
  // No stamp at all → nothing was returned.
  if (!p['Refunded At']) return false;
  // `Refunded At` WITHOUT the status flip means partial (or a write that
  // landed half-way). Belt: if the amounts are legible and the refund covers
  // everything the buyer was charged, treat it as full anyway.
  const refunded = Number(p['Refunded Amount Cents'] || 0);
  const captured = capturedCentsOf(p);
  return refunded > 0 && captured > 0 && refunded >= captured;
}

/**
 * Should automated OUTREACH about this deposit stop?
 *
 * Deliberately BROADER than isMoneyReturnedToBuyer, and deliberately UNCHANGED
 * by the B3 fix. Any refund at all — even a $1 goodwill one — and any dispute,
 * in flight or settled, silences the send rails: lib/depositSla's own re-ping
 * and 72h escalation, and lib/reserveRecovery's buyer email/SMS. Emailing a
 * partly-refunded buyer "come finish your reserve", or nudging a rancher about
 * a slot whose money is being contested, is a send you cannot take back, and
 * every one of those behaviours is separately pinned in the tests beside this
 * file.
 *
 * The obligations band must NOT use this one. A band is a READ: showing a
 * partly-refunded deal costs nothing and hiding it loses a customer who is
 * still owed beef. That is why the two predicates exist — see
 * isMoneyReturnedToBuyer, which is the narrow "the money actually went back"
 * test, and lib/obligations, which calls it.
 */
export function isRefundedOrDisputed(ref: SlaReferralLike): boolean {
  // Referral-side (Closed Won refund path / defense-in-depth).
  if (ref['Refunded At']) return true;
  if (hasAnyDispute(ref['Dispute Status'])) return true;

  // Payments-side — the authoritative signal for the blocker case.
  const p = ref.__payment;
  if (p) {
    if (p['Refunded At']) return true;                       // full OR partial refund stamps this
    if (String(p.Status || '').toLowerCase() === 'refunded') return true;
    if (hasAnyDispute(p['Dispute Status'])) return true;
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
 * loud operator escalation". Same hard exclusions as the re-ping (terminal
 * status, refunded/disputed, accepted) — the cron throttles the actual send
 * per referral (claimOnce at escalationClaimTtlSec + sendOperatorSignal
 * dedupeKey), so this returning true on every run after 72h is safe by design.
 *
 * P0-2 (2026-08-18): that throttle is now a COOLDOWN, not a life sentence —
 * see RE_ESCALATE_COOLDOWN_DAYS. The predicate itself is unchanged: it says
 * "this deal is past 72h and still unresolved", which stays true every run
 * until someone accepts, refunds or closes it.
 *
 * BROKER ROWS ARE DELIBERATELY NOT EXCLUDED (2026-08-17). They are excluded
 * from the re-ping (isSlaEligible) because that rail's copy is Connect-only,
 * but the escalation is the opposite case: on the broker rail NOTHING in the
 * system can tell us whether the ranch ever called the buyer — there is no
 * Accept, no thread, no payout event — so a one-shot "did the ranch make
 * contact?" prompt to a human is the only backstop that exists, and dropping it
 * would leave broker sales with no safety net at all. It is operator-facing,
 * repeats only on the RE_ESCALATE_COOLDOWN_DAYS cadence, and the cron renders
 * broker-correct copy for it
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
