// lib/lossRecovery.ts
//
// LOSS-RECOVERY RAILS — pure selection + mapping for the loss-recovery cron
// (app/api/cron/loss-recovery). A rancher marks a referral Closed Lost with a
// structured 'Loss Reason' (singleSelect fldV4hf0ptyhMaaAA); this module
// decides which of those losses are actually recoverable and what the ONE
// follow-up action is:
//
//   "Couldn't reach buyer"    → RE-ENGAGE  (email + opted-in SMS: "still want it?")
//   'Price too high'          → DOWNSELL   (quarter share / shop boxes)
//   'Timing — buying later'   → NURTURE    (no email now; defer ~60d via the
//                                           EXISTING re-warm rail — see below)
//   'Bought elsewhere' / 'Out of service area' /
//   'Wrong intent (not a buyer)' / 'Other' → NONE (terminal; counted only)
//
// SEQUENCING NOTE: PR #396 (the rancher-UI 'Loss Reason' writers) is MERGED —
// this rail selects real candidates from day one, in DRY-RUN until Ben flips
// LOSS_RECOVERY_ENABLED.
//
// VOCABULARY: this module used to pin its OWN byte-for-byte copy of the 7
// choice strings, because it was branched before #396 landed lib/lossReasons.
// That reason expired the moment #396 merged: two copies of a typecast:true
// singleSelect vocabulary is exactly how schema drift gets minted silently.
// lib/lossReasons is now the single source of truth (writers AND this reader
// share it) and `actionForLossReason`'s switch is exhaustiveness-checked
// against it — add a choice there and this file fails to COMPILE until it
// says what the new reason should do. Re-exported here so existing importers
// (and the tests) keep working.
//
// THE ~60-DAY NURTURE DEFERRAL (no new scheduler): the codebase's existing
// deferred-follow-up rail is re-warm-cohort — it reanimates any Approved,
// unengaged buyer whose 'Warmup Sent At' is 60+ days old by clearing the
// warmup fields, which drops them back into rancher-launch-warmup's fresh
// candidate set (lifetime 2-attempt cap + suppression respected by that cron,
// not us). So the nurture action is a single scheduled-style stamp the
// existing crons already read: 'Warmup Sent At' = now (60-day anchor) +
// 'Warmup Stage' = 'nudged' (suppresses rancher-launch-warmup's own day-7
// nudge so the buyer hears NOTHING until the re-warm rail wakes them).
//
// shouldStampRewarm MIRRORS THE FULL re-warm-cohort candidate filter (Status
// = Approved, no 'Warmup Engaged At', 'Ready to Buy' falsy, Re-Warm Attempts
// < 2). A buyer that filter would never pick up must NOT be stamped — the
// stamp would remove a never-warmed buyer from rancher-launch-warmup Phase 1
// (NOT({Warmup Sent At})) with no rail ever waking them again: permanent
// silence, strictly worse than doing nothing. Non-stampable nurture
// candidates are SKIPPED by the selector ('nurture-not-rewarmable'): no
// touch, no 'Recovery Sent At' burn, honest counts.
//
// PURE: dependency-free decisions over plain Airtable-shaped rows (mirrors
// lib/productRecovery / lib/replenishment) so everything unit-tests with zero
// network. The cron does the reads, the claim-before-send stamp, the sends.

import { isActiveDealReferral } from './capacityCount';
import { LOSS_REASON_CHOICES, isLossReasonChoice, type LossReason } from './lossReasons';

// ── Airtable field names ─────────────────────────────────────────────────────
export const LOSS_REASON_FIELD = 'Loss Reason'; // fldV4hf0ptyhMaaAA (singleSelect)
export const RECOVERY_SENT_AT_FIELD = 'Recovery Sent At'; // fldytetWcVovzLqWZ (dateTime)

// Canonical vocabulary lives in lib/lossReasons (see header). Re-exported so
// this module stays the one import the recovery rail needs.
export { LOSS_REASON_CHOICES };
export type { LossReason };

export type RecoveryAction = 'reengage' | 'downsell' | 'nurture' | 'none';

// Defaults (cron overrides cap via LOSS_RECOVERY_MAX_PER_RUN).
export const DEFAULT_WINDOW_DAYS = 14;
export const DEFAULT_MAX_PER_RUN = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

// Airtable singleSelect values sometimes arrive as {name} objects depending on
// the read path — normalize like the rest of the codebase does.
function readEnumOrString(v: unknown): string {
  if (v && typeof v === 'object' && 'name' in (v as any)) return String((v as any).name || '');
  return String(v ?? '');
}

/**
 * Map a raw 'Loss Reason' value → recovery action.
 * Returns null for blank/unknown values (skip + count, never guess) and
 * 'none' for the terminal reasons (counted in the run log, no outreach).
 */
export function actionForLossReason(raw: unknown): RecoveryAction | null {
  const reason = readEnumOrString(raw).trim();
  // Blank, or a value outside the canonical vocabulary (schema drift, a
  // hand-typed option, a case/dash variant): skip loudly in the counts and
  // NEVER guess an action from a string we don't recognize.
  if (!isLossReasonChoice(reason)) return null;
  switch (reason) {
    case "Couldn't reach buyer":
      return 'reengage';
    case 'Price too high':
      return 'downsell';
    case 'Timing — buying later':
      return 'nurture';
    case 'Bought elsewhere':
    case 'Out of service area':
    case 'Wrong intent (not a buyer)':
    case 'Other':
      return 'none';
    default: {
      // Compile-time exhaustiveness against lib/lossReasons: adding a choice
      // there without deciding what this rail does with it fails the BUILD,
      // instead of silently dropping those losses on the floor at runtime.
      const unhandled: never = reason;
      void unhandled;
      return null;
    }
  }
}

/**
 * Human cut label for email copy, from the referral's Order Type
 * ("Quarter Beef" → 'quarter'). Falls back to 'beef share' so copy always
 * reads naturally. Mirrors lib/demandRouter.cutForBuyer's parsing.
 */
export function cutLabelFromOrderType(raw: unknown): string {
  const first = readEnumOrString(raw).trim().toLowerCase().split(/\s+/)[0];
  if (first === 'quarter' || first === 'half' || first === 'whole') return first;
  return 'beef share';
}

/** Email-reachable and not suppressed (checkbox flags + Status mirror). */
export function isBuyerContactable(c: Record<string, unknown> | null | undefined): boolean {
  if (!c) return false;
  const email = String(c['Email'] || '').trim();
  if (!email || !email.includes('@')) return false;
  if (c['Unsubscribed'] === true) return false;
  if (c['Bounced'] === true) return false;
  if (c['Complained'] === true) return false;
  const status = readEnumOrString(c['Status']).trim();
  if (status === 'Unsubscribed' || status === 'Bounced' || status === 'Complained' || status === 'Spam') {
    return false;
  }
  return true;
}

/**
 * SMS leg eligibility — STRICT === true to match sendSMSToConsumer's TCPA gate
 * exactly (the A6 lesson: a loose-truthy check here would plan an SMS the
 * sender then refuses). Phone presence checked so the plan is honest.
 */
export function isSmsEligible(c: Record<string, unknown> | null | undefined): boolean {
  if (!c) return false;
  if (c['SMS Opt-In'] !== true) return false;
  if (c['Unsubscribed'] === true) return false;
  return String(c['Phone'] || '').trim().length > 0;
}

/** Mirror of re-warm-cohort's MAX_REWARM_ATTEMPTS lifetime cap. */
export const MAX_REWARM_ATTEMPTS = 2;

/**
 * Should the nurture action stamp the re-warm anchor on this buyer?
 *
 * MIRRORS THE FULL re-warm-cohort candidate filter (route + its JS filter):
 *   Status = "Approved" AND no 'Warmup Engaged At' AND 'Ready to Buy' falsy
 *   AND Re-Warm Attempts < 2 (suppression flags are the selector's
 *   isBuyerContactable gate). Stamping a buyer that filter would never pick
 *   up is worse than a dead write: 'Warmup Sent At' also removes them from
 *   rancher-launch-warmup Phase 1 (NOT({Warmup Sent At})) — a never-warmed
 *   buyer would go permanently silent. If this returns false the selector
 *   SKIPS the candidate entirely (no touch, no 'Recovery Sent At' burn).
 */
export function shouldStampRewarm(c: Record<string, unknown> | null | undefined): boolean {
  if (!c) return false;
  if (c['Warmup Engaged At']) return false;
  if (readEnumOrString(c['Status']).trim() !== 'Approved') return false;
  // Truthy check matches re-warm-cohort line-for-line: Ready to Buy buyers
  // route through matching/suggest on the next batch-approve run instead.
  if (c['Ready to Buy']) return false;
  if ((Number(c['Re-Warm Attempts']) || 0) >= MAX_REWARM_ATTEMPTS) return false;
  return true;
}

/**
 * Is this referral's close inside the recovery window?
 *
 * 'Closed At' is often unstamped (it's a singleLineText only some writers
 * fill) and Referrals has NO lastModifiedTime field to read — so the cron
 * pushes the freshness bound into the Airtable read itself via
 * IS_AFTER(LAST_MODIFIED_TIME(), DATEADD(NOW(), -window, 'days')) and tells
 * us with `windowEnforcedUpstream`. Rules:
 *   - parseable 'Closed At' → it decides (belt even when upstream enforced);
 *   - missing/unparseable   → trust the upstream formula; if the read fell
 *     back to an unwindowed scan, be conservative and EXCLUDE.
 */
export function isClosedWithinWindow(
  ref: Record<string, unknown>,
  nowMs: number,
  windowDays: number,
  windowEnforcedUpstream: boolean,
): boolean {
  const closedMs = Date.parse(String(ref['Closed At'] || ''));
  if (Number.isFinite(closedMs)) {
    return nowMs - closedMs <= windowDays * DAY_MS && closedMs <= nowMs + DAY_MS;
  }
  return windowEnforcedUpstream;
}

export interface LossRecoveryCandidate {
  referralId: string;
  buyerId: string;
  action: Exclude<RecoveryAction, 'none'>;
  reason: string;
  email: string;
  firstName: string;
  /** 'quarter' | 'half' | 'whole' | 'beef share' — for copy. */
  cut: string;
  state: string;
  smsEligible: boolean;
  existingNotes: string;
}

export interface LossRecoverySelection {
  planned: LossRecoveryCandidate[];
  /** {skip reason: count} — feeds the Cron Runs Skip Reason Breakdown. */
  skips: Record<string, number>;
  /** Per-'Loss Reason' tally across ALL closed-lost candidates seen. */
  reasonCounts: Record<string, number>;
  /** Eligible-but-over-cap count (deferred to tomorrow's run). */
  capped: number;
}

export interface SelectLossRecoveryInput {
  /** Closed Lost referral rows (the cron's filtered read). */
  candidates: Array<Record<string, any>>;
  /** Active-deal referral rows (activeDealReferralsFormula read) — used to
   *  exclude any buyer who already has a live deal elsewhere. */
  activeReferrals: Array<Record<string, any>>;
  /** Consumer rows keyed by record id. */
  consumersById: Map<string, Record<string, any>>;
  nowMs: number;
  windowDays?: number;
  cap?: number;
  windowEnforcedUpstream?: boolean;
}

/**
 * THE selector. Order of gates matters for honest skip accounting:
 * status → reason present/known → reason tally → terminal? → once-only
 * (Recovery Sent At) → 14d window → buyer link → contactable → no other
 * active referral → per-buyer dedupe → cap.
 */
export function selectLossRecovery(input: SelectLossRecoveryInput): LossRecoverySelection {
  const {
    candidates,
    activeReferrals,
    consumersById,
    nowMs,
    windowDays = DEFAULT_WINDOW_DAYS,
    cap = DEFAULT_MAX_PER_RUN,
    windowEnforcedUpstream = false,
  } = input;

  const skips: Record<string, number> = {};
  const reasonCounts: Record<string, number> = {};
  const skip = (why: string) => { skips[why] = (skips[why] || 0) + 1; };

  // Buyers with a live deal anywhere — recovery never talks over a rancher.
  const activeBuyerIds = new Set<string>();
  for (const r of activeReferrals || []) {
    if (!isActiveDealReferral(r)) continue;
    for (const b of (r['Buyer'] || []) as string[]) activeBuyerIds.add(b);
  }

  const planned: LossRecoveryCandidate[] = [];
  const plannedBuyers = new Set<string>();
  let capped = 0;

  for (const ref of candidates || []) {
    if (readEnumOrString(ref['Status']).trim() !== 'Closed Lost') { skip('not-closed-lost'); continue; }

    // My Leads (2026-07-29): a rancher-entered lead ('Referral Source' =
    // 'rancher-added') that closed lost is the RANCHER's own relationship —
    // recovery emails would market to a buyer who never consented, and a
    // 're-engage' action could route them toward a DIFFERENT rancher. Skip
    // before any action mapping. (Belt: the My Leads lost path also writes
    // Loss Reason 'Other', whose action is 'none'.)
    if (readEnumOrString(ref['Referral Source']).trim() === 'rancher-added') {
      skip('rancher-added-crm');
      continue;
    }

    const reason = readEnumOrString(ref[LOSS_REASON_FIELD]).trim();
    const action = actionForLossReason(reason);
    if (!reason) { skip('no-loss-reason'); continue; } // pre-#396 rows — graceful no-op
    if (action === null) { skip('unknown-loss-reason'); continue; } // schema drift — never guess

    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    if (action === 'none') { skip('terminal-reason'); continue; }

    if (ref[RECOVERY_SENT_AT_FIELD]) { skip('already-recovered'); continue; } // once, ever
    if (!isClosedWithinWindow(ref, nowMs, windowDays, windowEnforcedUpstream)) { skip('outside-window'); continue; }

    const buyerId = Array.isArray(ref['Buyer']) ? String(ref['Buyer'][0] || '') : '';
    if (!buyerId) { skip('no-buyer-link'); continue; }
    const buyer = consumersById.get(buyerId);
    if (!buyer) { skip('buyer-not-found'); continue; }
    if (!isBuyerContactable(buyer)) { skip('buyer-suppressed'); continue; }
    if (activeBuyerIds.has(buyerId)) { skip('active-referral-elsewhere'); continue; }
    if (plannedBuyers.has(buyerId)) { skip('duplicate-buyer'); continue; } // one touch per buyer per run

    // Nurture is ONLY worth a touch if the re-warm rail will actually wake
    // the buyer later — otherwise the stamp is permanent silence (see
    // shouldStampRewarm). Skip: no send, no 'Recovery Sent At' burn; the row
    // ages out of the 14d window on its own.
    if (action === 'nurture' && !shouldStampRewarm(buyer)) { skip('nurture-not-rewarmable'); continue; }

    if (planned.length >= cap) { capped++; continue; }

    planned.push({
      referralId: String(ref.id || ''),
      buyerId,
      action,
      reason,
      email: String(buyer['Email'] || '').trim().toLowerCase(),
      firstName: String(buyer['Full Name'] || '').trim().split(/\s+/)[0] || 'there',
      cut: cutLabelFromOrderType(ref['Order Type']),
      state: String(buyer['State'] || '').trim(),
      smsEligible: action === 'reengage' && isSmsEligible(buyer),
      existingNotes: String(ref['Notes'] || ''),
    });
    plannedBuyers.add(buyerId);
  }

  return { planned, skips, reasonCounts, capped };
}

/** Referral Notes audit line (no buyer names — internal log hygiene). */
export function recoveryNoteLine(action: Exclude<RecoveryAction, 'none'>, reason: string, nowMs: number): string {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const label = action === 'reengage' ? 're-engage email' : action === 'downsell' ? 'downsell email' : 'nurture stamp (~60d re-warm)';
  return `[loss-recovery ${day}: ${reason} → ${label}]`;
}

/**
 * Re-engage SMS body (opted-in buyers only; the cron additionally gates on
 * sendSMSToConsumer's TCPA check + the local SMS send-window). Always carries
 * STOP. Lowercase, ONE CTA (the link), no fake urgency — house voice.
 *
 * NEVER promise a "reply YES" flow here: the Twilio inbound webhook
 * classifies YES as a START keyword (re-subscribe confirmation TwiML) — no
 * human sees it and no call gets set up. The link is the only honest CTA.
 */
export function renderReengageSms(ctx: { firstName: string; cut: string; link: string }): string {
  return (
    `BuyHalfCow: ${ctx.firstName}, your rancher tried to reach you about your ${ctx.cut} and couldn't get through — ` +
    `still want it? grab your spot: ${ctx.link}\n` +
    `reply STOP to opt out`
  );
}
