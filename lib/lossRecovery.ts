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
// SEQUENCING NOTE: nothing on main writes 'Loss Reason' yet — the rancher UI
// writers land in PR #396. Until then every run selects zero candidates and
// no-ops gracefully; the rail goes live the moment #396 merges. The 7 choice
// strings below are pinned byte-for-byte to the PROD schema (em-dash U+2014
// in 'Timing — buying later', straight apostrophe U+0027 in "Couldn't reach
// buyer") — deliberately a LOCAL copy so this branch merges cleanly whether
// or not #396 (which ships its own lib/lossReasons vocabulary) lands first.
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
// Buyers with 'Warmup Engaged At' set are excluded by the re-warm rail's own
// filter, so we skip the stamp for them (shouldStampRewarm).
//
// PURE: dependency-free decisions over plain Airtable-shaped rows (mirrors
// lib/productRecovery / lib/replenishment) so everything unit-tests with zero
// network. The cron does the reads, the claim-before-send stamp, the sends.

import { isActiveDealReferral } from './capacityCount';

// ── Airtable field names ─────────────────────────────────────────────────────
export const LOSS_REASON_FIELD = 'Loss Reason'; // fldV4hf0ptyhMaaAA (singleSelect)
export const RECOVERY_SENT_AT_FIELD = 'Recovery Sent At'; // fldytetWcVovzLqWZ (dateTime)

// Prod singleSelect choices, byte-for-byte (verified against schema 2026-07-15).
export const LOSS_REASON_CHOICES = [
  'Price too high',
  'Timing — buying later',
  "Couldn't reach buyer",
  'Bought elsewhere',
  'Out of service area',
  'Wrong intent (not a buyer)',
  'Other',
] as const;
export type LossReason = (typeof LOSS_REASON_CHOICES)[number];

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
  if (!reason) return null;
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
    default:
      return null; // unknown choice — schema drifted; skip loudly in counts
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

/**
 * Should the nurture action stamp the re-warm anchor on this buyer?
 * Engaged buyers ('Warmup Engaged At' set) are permanently outside the
 * re-warm rail's candidate filter — stamping them would be a dead write.
 */
export function shouldStampRewarm(c: Record<string, unknown> | null | undefined): boolean {
  if (!c) return false;
  return !c['Warmup Engaged At'];
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
  /** nurture only: whether to stamp the re-warm anchor on the Consumer. */
  rewarmStamp: boolean;
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
      rewarmStamp: action === 'nurture' && shouldStampRewarm(buyer),
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
 * STOP. Lowercase, one link, no fake urgency — house voice.
 */
export function renderReengageSms(ctx: { firstName: string; cut: string; link: string }): string {
  return (
    `BuyHalfCow: ${ctx.firstName}, your rancher tried to reach you about your ${ctx.cut} and couldn't get through — ` +
    `still want it? tap ${ctx.link} or reply YES and we'll set the call up right this time.\n` +
    `reply STOP to opt out`
  );
}
