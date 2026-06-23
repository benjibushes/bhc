// Capacity Liberator — pure helpers for deciding which rancher slots are dead
// (stale leads) and which ranchers have real ORDER headroom.
//
// The core reframe: capacity is measured by COMMITTED ORDERS (slot-locked /
// awaiting-payment / recently closed-won), NOT by raw lead count. A rancher
// sitting on 5 ghosted intros and 0 sales should still get buyers. See
// docs/CAPACITY-LIBERATOR-PLAN.md.
//
// These functions are pure + side-effect-free on purpose — all Airtable I/O
// lives in the cron route, so the decision logic stays trivially reviewable.
//
// BUYER-REPLY GATE: the activity timestamp fields are NOT trustworthy —
// `Last Buyer Activity At` is blank table-wide (the inbound webhook only stamps
// it when a reply resolves a ref-<id> tag, which real replies don't hit). So we
// detect a buyer reply from the Conversations table directly: any inbound reply
// whose From-email matches the referral's Buyer Email (or that links the
// referral). A referral with a reply is NEVER released, even if its timestamps
// look cold. We DO also honor Last Chased At so we never release a lead we're
// actively chasing.

import { isRancherOperationalForBuyers } from '@/lib/rancherEligibility';
import { getMaxActiveReferrals } from '@/lib/rancherCapacity';

export const STALE_WINDOW_DAYS = 14;
export const COMMIT_CYCLE_DAYS = 30;
export const ATTENTION_MULTIPLIER = 1.2;
const DAY_MS = 86_400_000;

/** Referral statuses that hold a slot but carry no committed money. */
export const LEAD_STATUSES = ['Intro Sent', 'Rancher Contacted', 'Negotiation'] as const;
const LEAD_STATUS_SET = new Set<string>(LEAD_STATUSES);

/** Statuses that occupy a fulfillment slot = a committed order. */
export const COMMITTED_STATUSES = ['Slot Locked', 'Awaiting Payment', 'Closed Won'] as const;
const COMMITTED_INFLIGHT = new Set<string>(['Slot Locked', 'Awaiting Payment']);

type Rec = Record<string, unknown>;

function ms(v: unknown): number {
  if (!v) return 0;
  const t = new Date(v as string).getTime();
  return Number.isFinite(t) ? t : 0;
}

function bareEmail(v: unknown): string {
  const raw = String(v ?? '').trim();
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

// ---- Buyer-reply gate ----------------------------------------------------

export interface ReplyIndex {
  emails: Set<string>;
  referralIds: Set<string>;
}

/**
 * Build the reply index from inbound Conversations rows. A row counts if it's
 * an inbound reply with a From address. We index BOTH the From email (the
 * signal that works today) and any Linked Referral ids (future-proof).
 */
export function buildReplyIndex(inboundConvos: Rec[]): ReplyIndex {
  const emails = new Set<string>();
  const referralIds = new Set<string>();
  for (const c of inboundConvos) {
    const addr = bareEmail(c['From']);
    if (addr) emails.add(addr);
    const link = c['Linked Referral'];
    if (Array.isArray(link)) {
      for (const id of link) if (typeof id === 'string') referralIds.add(id);
    }
  }
  return { emails, referralIds };
}

/** True if this referral's buyer has ever replied (by linked id or From-email match). */
export function hasBuyerReply(ref: Rec, idx: ReplyIndex): boolean {
  const id = String(ref['id'] ?? '');
  if (id && idx.referralIds.has(id)) return true;
  const email = bareEmail(ref['Buyer Email']);
  return email ? idx.emails.has(email) : false;
}

// ---- Staleness / commitment ----------------------------------------------

/**
 * Most recent signal on a referral. Includes Last Chased At so we never treat a
 * lead we just emailed as dead — outreach in flight = the lead is still live.
 */
export function latestActivityMs(ref: Rec): number {
  return Math.max(
    ms(ref['Last Rancher Activity At']),
    ms(ref['Last Buyer Activity At']),
    ms(ref['Last Chased At']),
    ms(ref['Intro Sent At']),
  );
}

/**
 * A lead is "stale" (its slot should be freed) when it is in a lead status, has
 * no money on it, hasn't already been auto-released, and has shown zero
 * activity (including no chase) for longer than the window. Conservative: never
 * release a referral with a deposit, a rancher acceptance, or no activity
 * signal at all. NOTE: the buyer-reply gate is applied separately in
 * computeHeadroom (it needs the reply index), so this stays a pure per-ref test.
 */
export function isStaleReferral(ref: Rec, nowMs: number, windowDays: number = STALE_WINDOW_DAYS): boolean {
  if (!LEAD_STATUS_SET.has(String(ref['Status'] ?? ''))) return false;
  if (ref['Deposit Paid At']) return false;
  if (ref['Rancher Accepted At']) return false;
  if (ref['Auto Released At']) return false;
  const last = latestActivityMs(ref);
  if (!last) return false;
  return nowMs - last > windowDays * DAY_MS;
}

/**
 * A committed order. In-flight commitments (Slot Locked, Awaiting Payment)
 * always occupy a slot. A Closed Won counts only if it closed within the
 * current cycle (older wins belong to a prior cycle and free up this cycle's
 * capacity). Deliberately status-based, not deposit-timestamp based — most
 * referrals never carry a Deposit Paid At.
 */
export function isCommittedOrder(ref: Rec, nowMs: number, cycleDays: number = COMMIT_CYCLE_DAYS): boolean {
  const status = String(ref['Status'] ?? '');
  if (COMMITTED_INFLIGHT.has(status)) return true;
  if (status === 'Closed Won') {
    const closed = ms(ref['Closed At']) || ms(ref['Deposit Paid At']);
    if (!closed) return true; // closed but undated → assume it still occupies the cycle
    return nowMs - closed <= cycleDays * DAY_MS;
  }
  return false;
}

/**
 * The rancher's order-fulfillment ceiling. Uses the explicit Monthly Order
 * Capacity field first; falls back to the live-lead cap (Max Active Referalls)
 * until a real number is set per rancher.
 */
export function orderCapacityFor(rancher: Rec): number {
  const moc = rancher['Monthly Order Capacity'];
  if (moc !== undefined && moc !== null && moc !== '') {
    const n = Number(moc);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return getMaxActiveReferrals(rancher);
}

/**
 * Which ranchers the liberator scans. Reuses the routing source-of-truth
 * (isRancherOperationalForBuyers — Active + Signed + Onboarding Live + sub OK,
 * NOT gated on Page Live) AND additionally includes fully-onboarded ranchers
 * currently flagged "At Capacity" (the reopen target, which fails the strict
 * Active check). Paused ranchers never qualify.
 */
export function isLiberatorScope(rancher: Rec): boolean {
  if (isRancherOperationalForBuyers(rancher)) return true;
  if (String(rancher['Active Status'] ?? '') !== 'At Capacity') return false;
  const onboarding = String(rancher['Onboarding Status'] ?? '');
  if (onboarding && onboarding !== 'Live') return false;
  if (!rancher['Agreement Signed']) return false;
  const sub = String(rancher['Subscription Status'] || '').toLowerCase();
  if (sub === 'past_due' || sub === 'unpaid' || sub === 'canceled') return false;
  return true;
}

export interface RancherHeadroom {
  orderCap: number;
  committed: number;
  headroom: number;
  liveLeads: number;
  staleCount: number;
  liveLeadsAfterRelease: number;
  attentionCeiling: number;
  shouldReopen: boolean;
}

/**
 * Pure roll-up of one rancher's capacity picture from its lead-status referrals
 * and its committed-order referrals. A lead is released only if it is stale AND
 * the buyer hasn't replied (reply index). No I/O — the cron fetches + groups +
 * builds the reply index, this decides.
 */
export function computeHeadroom(
  rancher: Rec,
  leadRefs: Rec[],
  committedRefs: Rec[],
  nowMs: number,
  replyIdx?: ReplyIndex,
): RancherHeadroom {
  const staleCount = leadRefs.filter(
    (r) => isStaleReferral(r, nowMs) && !(replyIdx ? hasBuyerReply(r, replyIdx) : false),
  ).length;
  const committed = committedRefs.filter((r) => isCommittedOrder(r, nowMs)).length;
  const orderCap = orderCapacityFor(rancher);
  const headroom = orderCap - committed;
  const liveLeads = leadRefs.length;
  const liveLeadsAfterRelease = liveLeads - staleCount;
  const attentionCeiling = Math.ceil(getMaxActiveReferrals(rancher) * ATTENTION_MULTIPLIER);
  const atCapacity = String(rancher['Active Status'] ?? '') === 'At Capacity';
  const shouldReopen = atCapacity && headroom > 0 && liveLeadsAfterRelease < attentionCeiling;
  return {
    orderCap,
    committed,
    headroom,
    liveLeads,
    staleCount,
    liveLeadsAfterRelease,
    attentionCeiling,
    shouldReopen,
  };
}
