// BROKER RAIL × EVERYTHING DOWNSTREAM OF A MATCH — the one shared predicate.
//
// ⚠️ THIS FILE IS A MONEY GUARD. Read docs/BUSINESS-MODEL.md model 3 and
// lib/brokerMatch.ts's header first.
//
// WHY THIS EXISTS
// ---------------
// lib/brokerMatch gates the three send sites inside app/api/matching/suggest.
// That is necessary and NOT sufficient. A broker match writes a referral row
// that is SHAPE-IDENTICAL to a Connect lead — Status 'Intro Sent', `Rancher`
// link set, `Deposit Invite Sent At` stamped — and every downstream rail keys
// off that shape:
//
//   • the daily rancher lead DIGEST emails the linked ranch the buyer's phone
//     and email (app/api/cron/referral-chasup);
//   • the deposit-abandon nudge emails the BUYER the ranch's phone as an
//     sms: link, up to 6 times over 21 days (app/api/cron/deposit-request-nudge);
//   • /member renders the ranch's email + phone as live mailto:/tel: links
//     (app/api/member/content → app/member/page.tsx);
//   • the admin "Resend intro" button re-fires BOTH halves of the Connect
//     double intro (app/api/admin/referrals/[id]/resend-intro);
//   • three more Connect intro paths fire if the match's 'Intro Sent' write
//     ever throws and the row is later promoted from 'Pending Approval'
//     (email-sequences promote-pa, telegram /bulkfire, telegram approve_).
//
// On the CONNECT rail every one of those is correct: BHC's commission is an
// application_fee on the rancher's own Stripe account, so the two parties
// talking IS the product. On the BROKER rail each one is a total revenue loss —
// BHC's entire fee is the deposit on BHC's own Stripe account, so a buyer who
// gets the ranch's phone number before paying simply buys direct and BHC earns
// $0 on a lead it sourced, qualified and routed.
//
// Five inline checks would drift. This is one predicate, with one fail-closed
// contract, that all of them consult.
//
// HERMETIC — imports lib/brokerRail and lib/commission, the same pair
// lib/depositSla rides (brokerRail imports lib/pricing and nothing else;
// commission imports brokerRail and nothing else). The Airtable read is
// INJECTED (`loadRancher`), so every decision here is unit-tested without
// Airtable, and a route that forgets to pass a loader fails to compile.

import { isBrokerRancher } from './brokerRail';
import { isBrokerReferralRow } from './commission';

export type ReferralRail = 'broker' | 'connect';

/**
 * The answer whenever the rail cannot be PROVEN to be Connect.
 *
 * Asymmetry of costs, and it is not close:
 *   • wrongly "broker"  → one email is skipped this run. The digest retries
 *     tomorrow, the nudge retries on its next touch, /member shows the message
 *     thread instead of a phone number. Fully recoverable.
 *   • wrongly "connect" → the ranch's contact details reach the buyer, they
 *     transact direct, and BHC's entire fee on that sale is gone. There is no
 *     later run that recovers it.
 */
export const BROKER_RAIL_FAIL_CLOSED: ReferralRail = 'broker';

export interface RailReferralLike {
  id?: string;
  Status?: unknown;
  Rancher?: unknown;
  'Suggested Rancher'?: unknown;
  /** Stamped at mint by lib/brokerReferral — conclusive POSITIVE on its own. */
  'Match Type'?: unknown;
  /** Stamped when the broker deposit settles. Gates buyer-facing contact. */
  'Deposit Paid At'?: unknown;
  /** Stamped when the deposit was ASKED for — deliberately NOT a reveal
   *  trigger; asking is not being paid. Declared so a caller passing a whole
   *  referral row type-checks. */
  'Deposit Requested At'?: unknown;
  /** Anything else on the Airtable row. */
  [field: string]: unknown;
  /** Optional: the linked Ranchers row, when the caller already read it. */
  __rancher?: unknown;
}

/** Loads a Ranchers row by id. Injected so this module stays Airtable-free. */
export type RancherLoader = (rancherId: string) => Promise<any>;

/**
 * Which rancher does this referral point at? `Rancher` (the assigned link)
 * wins; `Suggested Rancher` is the pre-approval fallback. Every downstream
 * site had its own copy of this two-field dance — that is exactly the drift
 * this module exists to stop.
 */
export function rancherIdForReferral(ref: RailReferralLike | null | undefined): string {
  const pick = (v: unknown): string => {
    if (Array.isArray(v)) return String(v[0] || '').trim();
    return String(v || '').trim();
  };
  return pick(ref?.Rancher) || pick(ref?.['Suggested Rancher']);
}

/**
 * Does the REFERRAL itself carry the broker marker? True is conclusive; false
 * proves nothing (a Connect row and a broker row whose typecast label was
 * stripped look identical here), which is why this is never used as a negative.
 */
export function referralCarriesBrokerMarker(ref: RailReferralLike | null | undefined): boolean {
  return isBrokerReferralRow(ref);
}

/**
 * The rail of an ALREADY-LOADED Ranchers row.
 *
 * FAIL-CLOSED CONTRACT, stated precisely so nobody has to guess:
 *   • a non-object (null, undefined, a bare record id string) → 'broker'.
 *     Nothing was read, so Connect cannot be proven.
 *   • a real object with NO `Broker Rail` key → 'connect'. This is NOT
 *     ambiguity: Airtable omits unchecked checkboxes from the fields payload
 *     entirely, so "no key" is the normal wire shape of every Connect rancher
 *     in the base. Failing closed here would stop the entire Connect rail.
 */
export function railForLoadedRancher(rancher: unknown): ReferralRail {
  if (!rancher || typeof rancher !== 'object') return BROKER_RAIL_FAIL_CLOSED;
  return isBrokerRancher(rancher) ? 'broker' : 'connect';
}

/**
 * THE call every downstream site makes. Resolves the rail of a referral row,
 * reading the linked rancher only when it has to.
 *
 * Order matters:
 *   1. the referral's own broker marker — conclusive, no read needed;
 *   2. an already-attached `__rancher` — no second read;
 *   3. the injected loader. A throw, a null, or no rancher linked at all all
 *      land on BROKER_RAIL_FAIL_CLOSED.
 */
export async function resolveReferralRail(
  ref: RailReferralLike | null | undefined,
  loadRancher: RancherLoader,
): Promise<ReferralRail> {
  if (referralCarriesBrokerMarker(ref)) return 'broker';
  if (ref && typeof ref === 'object' && '__rancher' in ref && ref.__rancher != null) {
    return railForLoadedRancher(ref.__rancher);
  }
  const rancherId = rancherIdForReferral(ref);
  if (!rancherId) return BROKER_RAIL_FAIL_CLOSED;
  try {
    return railForLoadedRancher(await loadRancher(rancherId));
  } catch {
    return BROKER_RAIL_FAIL_CLOSED;
  }
}

/** Sugar for the common `=== 'broker'` test at a send site. */
export async function isBrokerRailReferralRow(
  ref: RailReferralLike | null | undefined,
  loadRancher: RancherLoader,
): Promise<boolean> {
  return (await resolveReferralRail(ref, loadRancher)) === 'broker';
}

/**
 * May THIS buyer be shown the ranch's email and phone right now?
 *
 *   connect → always. That rail IS an introduction; hiding contact would break
 *             the product and costs BHC nothing (the fee rides the deposit on
 *             the rancher's own Stripe account either way).
 *   broker  → only once `Deposit Paid At` is stamped. Before that, handing over
 *             the phone number is the direct-transaction leak. After it, BHC
 *             has already collected its ENTIRE fee on this sale and the buyer
 *             owes the ranch the balance directly — the broker settlement
 *             receipt (lib/brokerNotify) hands over the same details in the
 *             same breath, so withholding them here would only break the
 *             dashboard for a buyer who has already paid us.
 */
export function mayRevealRancherContact(
  ref: RailReferralLike | null | undefined,
  rail: ReferralRail,
): boolean {
  if (rail !== 'broker') return true;
  return !!String((ref as any)?.['Deposit Paid At'] ?? '').trim();
}
