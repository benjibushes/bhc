// lib/stuckRancherQueue.ts
//
// THE STUCK-RANCHER QUEUE — "which dead onboarding do I ring first?"
//
// Two crons stamp `Stuck Escalated At` on a rancher, fire ONE Telegram ping,
// and then go permanently silent by design:
//   app/api/cron/onboarding-stuck/route.ts   → connect-stuck | live-no-deposits
//                                              | signed-no-page | call-complete
//                                              | docs-sent
//   app/api/cron/rancher-followup/route.ts   → new-applicant
//
// That silence is CORRECT — it is what stopped the 4-day re-ping spam — but it
// left the platform with no LIST. 61 of 87 ranchers carry the stamp today and
// not one has ever been worked. The only record of an escalation was a Telegram
// message that scrolled past. This module turns those stamps into a ranked call
// list; supply is the company's #1 constraint and a rancher phone call is the
// only thing that moves it.
//
// Every field this module reads is verified against the live Airtable
// `Ranchers` schema (2026-07-25):
//   Stuck Escalated At · Stuck Escalated Bucket · Last Touch At ·
//   Onboarding Status · Active Status · Verification Status · Agreement Signed ·
//   Page Live · Pricing Model · Stripe Connect Account Id ·
//   Stripe Connect Status · Slug · Quarter/Half/Whole Price ·
//   Quarter/Half/Whole Payment Link · Unsubscribed · Bounced
//
// The bucket ladder and the missing-step copy below MIRROR the two crons above,
// field for field and in the same order, so the desk and the chase rail can
// never disagree about why a rancher is stuck. (The crons are not refactored to
// import this module: they are live money/outreach rails and this is a
// read-only reporting surface. If the cron ladder ever changes, change it here
// too — that is the one coupling this file carries, and it is why the ladder is
// written out rather than paraphrased.)
//
// PURE: no I/O, no Date.now() (the caller passes `now`), no mutation of input.

// ─── TUNING CONSTANTS — the whole scoring model lives here ─────────────────

/**
 * Weights sum to 100, so a score reads as "% of a perfect call".
 *
 * Why only two, and why this split:
 *   demand    60 — the buyers already waiting in the state this rancher would
 *                  serve ARE the prize. Unsticking a Texas rancher opens 264
 *                  waiting buyers; unsticking a Vermont rancher opens 5. Every
 *                  other consideration is secondary to how much demand the call
 *                  unlocks, so demand carries the majority of the score.
 *   proximity 40 — how few steps the rancher is from taking money. A rancher
 *                  one Stripe screen from payable converts a single call into
 *                  revenue this week; a never-started applicant may take three
 *                  calls and a re-send. Large enough to reorder within a state,
 *                  never large enough to outrank a much bigger market.
 *
 * Days-stuck is deliberately NOT a weight — it is the SORT TIE-BREAK (see
 * rankStuckRancherQueue). Both signals above are quantised (every rancher in a
 * state shares one demand number, and proximity is a fixed ladder), so exact
 * ties are the common case, not the rare one. Breaking those ties on "escalated
 * longest ago, still untouched" is precisely the right call order and it does
 * real work, whereas folding staleness into the score would let a 9-day-old
 * dead-state applicant outrank a 2-day-old Texas one. Nobody is rescued by
 * being called in the wrong order.
 */
export const WEIGHTS = {
  demand: 60,
  proximity: 40,
} as const;

export type ReasonKey = keyof typeof WEIGHTS;

/**
 * Waiting-buyer count at which the demand signal saturates.
 *
 * Live spread (2026-07-25, Buyer Stage='WAITING'): TX 264, CA 220, FL 124,
 * AZ 113, CO 87, then a long tail down to VT 5. 150 waiting buyers is already
 * more demand than one ranch can fill in a season, so past that another buyer
 * does not make the phone call more valuable. Saturating here also stops TX and
 * CA from flattening all 48 other states into a rounding error.
 */
export const DEMAND_CEILING = 150;

/**
 * PROXIMITY LADDER — 0..1, "how close is this rancher to taking money?"
 *
 * Checked top-down, first match wins, and it reads the SAME fields the crons
 * gate on so the ordering can never contradict the chase rail. Rungs are spaced
 * by how much work the founder has to do on the call, not evenly.
 */
export const PROXIMITY = {
  /** Connect is active, page just isn't published — publish and they're payable. */
  connectActiveNoPage: 0.95,
  /** Page is live, Connect is not: ONE Stripe screen between them and money. */
  liveNoDeposits: 0.9,
  /** Opened Stripe Connect and abandoned it — the known bank/SSN wall. */
  connectStarted: 0.75,
  /** Signed and priced; needs a slug / the payment rail wired. */
  signedWithPrice: 0.6,
  /** Signed the agreement, nothing else done. */
  signed: 0.5,
  /** Had the call, never signed. */
  callComplete: 0.35,
  /** Got the setup link, never opened it. */
  docsSent: 0.25,
  /** Applied and vanished — no onboarding status at all. */
  newApplicant: 0.1,
  /** Stamped stuck but matches no bucket today — they moved. */
  resolved: 0,
} as const;

/**
 * Active Status values that mean "an admin deliberately took this rancher out
 * of play". Calling them is not the point of this queue, so they never appear.
 * Mirrors the guard at the top of the rancher-followup cron.
 */
export const PARKED_ACTIVE_STATUSES = new Set(['Paused', 'Non-Compliant']);

/** Self-serve account closure. Never call a closed account. */
export const REMOVED_VERIFICATION_STATUS = 'Removed';

/** Default queue depth. Twelve calls is a morning. */
export const DEFAULT_STUCK_QUEUE_LIMIT = 12;

// ─── Types ─────────────────────────────────────────────────────────────────

export type StuckBucket =
  | 'connect-stuck'
  | 'live-no-deposits'
  | 'signed-no-page'
  | 'call-complete'
  | 'docs-sent'
  | 'new-applicant'
  | 'resolved';

/** Human label per bucket, for the desk table. */
export const BUCKET_LABEL: Record<StuckBucket, string> = {
  'connect-stuck': 'Connect stuck',
  'live-no-deposits': 'Live, no deposits',
  'signed-no-page': 'Signed, no page',
  'call-complete': 'Call complete',
  'docs-sent': 'Docs sent',
  'new-applicant': 'New applicant',
  resolved: 'Moved on',
};

/**
 * One escalated rancher, already flattened out of Airtable by the caller.
 * `buyersWaiting` is summed by the caller across getOperationalServedStates().
 */
export interface StuckRancherRow {
  id: string;
  ranchName: string;
  operatorName: string;
  state: string;
  email: string;
  phone: string;
  /** Unsubscribed or hard-bounced — show the row, hide the mailto:. */
  emailOptOut: boolean;
  activeStatus: string;
  verificationStatus: string;
  onboardingStatus: string;
  agreementSigned: boolean;
  pageLive: boolean;
  pricingModel: string;
  connectAccountId: string;
  connectStatus: string;
  hasSlug: boolean;
  maxPrice: number;
  hasPaymentLink: boolean;
  stuckEscalatedAt: string;
  stuckEscalatedBucket: string;
  /** Only written when the RANCHER replies to us (resend-inbound webhook). */
  lastTouchAt: string;
  /** Waiting buyers summed over the states this rancher would serve. */
  buyersWaiting: number;
  servedStates: string[];
}

export interface StuckRancherScore {
  score: number;
  signals: Record<ReasonKey, number>;
  points: Record<ReasonKey, number>;
  topReason: ReasonKey;
  why: string;
  bucket: StuckBucket;
  /** What is ACTUALLY missing right now — the thing to say on the phone. */
  missing: string[];
  daysStuck: number;
  proximity: number;
  /** True when the live bucket no longer matches what the cron escalated on. */
  bucketDrifted: boolean;
  /** No rancher reply has ever landed against this record. */
  neverWorked: boolean;
}

export type RankedStuckRancherRow = StuckRancherRow & StuckRancherScore;

// ─── Helpers ───────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

const lower = (v: string | undefined | null): string => String(v ?? '').trim().toLowerCase();

/** tier_v2 ranchers collect through Stripe Connect; legacy ones do not. */
function isTierV2(row: StuckRancherRow): boolean {
  return lower(row.pricingModel) === 'tier_v2';
}

function isConnectActive(row: StuckRancherRow): boolean {
  return lower(row.connectStatus) === 'active';
}

// ─── Bucket + missing-step derivation (mirrors the two crons) ───────────────

/**
 * Which stuck bucket does this rancher fall in RIGHT NOW?
 *
 * Order is onboarding-stuck's ladder verbatim, with rancher-followup's
 * new-applicant condition (`Onboarding Status` empty) appended as the last real
 * rung — that cron only reaches it after the mid-funnel stages are ruled out,
 * so appending preserves both crons' precedence.
 *
 * 'resolved' means the stamp is stale: the rancher has since progressed past
 * every stuck condition. Those are filtered out of the queue.
 */
export function deriveStuckBucket(row: StuckRancherRow): StuckBucket {
  const connectActive = isConnectActive(row);
  const hasConnectAcct = !!String(row.connectAccountId || '').trim();

  if (hasConnectAcct && !connectActive && !row.pageLive) return 'connect-stuck';
  if (isTierV2(row) && row.pageLive && !connectActive) return 'live-no-deposits';
  if (row.agreementSigned && !row.pageLive) return 'signed-no-page';
  if (row.onboardingStatus === 'Call Complete') return 'call-complete';
  if (row.onboardingStatus === 'Docs Sent') return 'docs-sent';
  if (!String(row.onboardingStatus || '').trim()) return 'new-applicant';
  return 'resolved';
}

/**
 * The concrete next step(s). Copy mirrors the crons' `missing[]` arrays so the
 * founder says on the phone exactly what the emails already asked for.
 */
export function missingSteps(row: StuckRancherRow, bucket = deriveStuckBucket(row)): string[] {
  switch (bucket) {
    case 'connect-stuck':
      return ['Started Stripe Connect and stopped — bank + identity, about 5 minutes'];
    case 'live-no-deposits':
      return ["Page is live but Stripe Connect isn't — every buyer deposit is blocked"];
    case 'signed-no-page': {
      const missing: string[] = [];
      if (!row.hasSlug) missing.push('A URL slug (My Page tab)');
      if (!(row.maxPrice > 0)) missing.push('At least one price');
      if (isTierV2(row)) {
        if (!isConnectActive(row)) missing.push('Connect your bank with Stripe');
      } else if (!row.hasPaymentLink) {
        missing.push('At least one payment link (Square / Stripe / PayPal)');
      }
      // Nothing left = the go-live-sync cron will flip them; onboarding-stuck
      // short-circuits this exact case rather than sending an empty checklist.
      return missing.length ? missing : ['Nothing missing — go-live sync should flip them'];
    }
    case 'call-complete':
      return ['Sign the partner agreement (1 click in the setup wizard)'];
    case 'docs-sent':
      return ['Never opened the setup link — resend it and walk them through the wizard'];
    case 'new-applicant':
      return ['Never started the wizard — no onboarding status was ever set'];
    case 'resolved':
      return [];
  }
}

/** 0..1 — how close to taking money, read off the same fields the crons gate on. */
export function proximityToPayable(row: StuckRancherRow): number {
  const connectActive = isConnectActive(row);
  const hasConnectAcct = !!String(row.connectAccountId || '').trim();

  if (connectActive && !row.pageLive) return PROXIMITY.connectActiveNoPage;
  if (row.pageLive && !connectActive) return PROXIMITY.liveNoDeposits;
  if (hasConnectAcct && !connectActive) return PROXIMITY.connectStarted;
  if (row.agreementSigned) {
    return row.maxPrice > 0 ? PROXIMITY.signedWithPrice : PROXIMITY.signed;
  }
  if (row.onboardingStatus === 'Call Complete') return PROXIMITY.callComplete;
  if (row.onboardingStatus === 'Docs Sent') return PROXIMITY.docsSent;
  if (!String(row.onboardingStatus || '').trim()) return PROXIMITY.newApplicant;
  return PROXIMITY.resolved;
}

/** Whole days since the cron gave up on this rancher. No stamp ⇒ 0. */
export function daysStuck(row: StuckRancherRow, now: number): number {
  const t = row.stuckEscalatedAt ? Date.parse(row.stuckEscalatedAt) : Number.NaN;
  if (!Number.isFinite(t)) return 0;
  const days = Math.floor((now - t) / 86_400_000);
  return days > 0 ? days : 0;
}

/**
 * True when an admin has deliberately parked this rancher (Paused /
 * Non-Compliant / self-serve Removed). Those never enter the call queue.
 */
export function isParked(row: StuckRancherRow): boolean {
  if (row.verificationStatus === REMOVED_VERIFICATION_STATUS) return true;
  return PARKED_ACTIVE_STATUSES.has(row.activeStatus);
}

// ─── Scoring ───────────────────────────────────────────────────────────────

function reasonSentence(
  key: ReasonKey,
  row: StuckRancherRow,
  bucket: StuckBucket,
  stale: number,
): string {
  if (key === 'demand') {
    const where = row.servedStates.length ? row.servedStates.join('/') : row.state || 'their state';
    return `${row.buyersWaiting} buyer${row.buyersWaiting === 1 ? '' : 's'} waiting in ${where} — biggest market of anyone stuck.`;
  }
  switch (bucket) {
    case 'live-no-deposits':
      return 'One Stripe screen from payable — their page is already live.';
    case 'connect-stuck':
      return 'Opened Stripe Connect and stopped at the bank step — closest to money of the unfinished.';
    case 'signed-no-page':
      return 'Already signed — only the page setup stands between them and buyers.';
    case 'call-complete':
      return 'Took the call, never signed — one signature away.';
    case 'docs-sent':
      return `Has the setup link and never opened it — ${stale}d since we stopped chasing.`;
    default:
      return 'Furthest along of the ranchers nobody has called.';
  }
}

/**
 * Score one escalated rancher 0..100. Higher = ring this one sooner.
 * Pure: same row + same `now` always yields the same score.
 */
export function scoreStuckRancher(row: StuckRancherRow, now: number): StuckRancherScore {
  const bucket = deriveStuckBucket(row);
  const proximity = proximityToPayable(row);
  const stale = daysStuck(row, now);

  const signals: Record<ReasonKey, number> = {
    demand: clamp01((Number(row.buyersWaiting) || 0) / DEMAND_CEILING),
    proximity: clamp01(proximity),
  };

  const points = {
    demand: signals.demand * WEIGHTS.demand,
    proximity: signals.proximity * WEIGHTS.proximity,
  };

  const score = round2(points.demand + points.proximity);

  // Top contributor; a dead heat goes to demand (WEIGHTS declaration order).
  const topReason: ReasonKey = points.proximity > points.demand ? 'proximity' : 'demand';

  return {
    score,
    signals,
    points,
    topReason,
    why: reasonSentence(topReason, row, bucket, stale),
    bucket,
    missing: missingSteps(row, bucket),
    daysStuck: stale,
    proximity,
    bucketDrifted: !!row.stuckEscalatedBucket && row.stuckEscalatedBucket !== bucket,
    neverWorked: !String(row.lastTouchAt || '').trim(),
  };
}

export interface RankStuckOptions {
  now: number;
  limit?: number;
}

export interface StuckQueueResult {
  rows: RankedStuckRancherRow[];
  /** Deliberately parked (Paused / Non-Compliant / Removed). */
  parkedCount: number;
  /** Stamped stuck but no longer matching any bucket — they progressed. */
  resolvedCount: number;
  /** Escalated ranchers still genuinely stuck, before `limit` is applied. */
  totalStuck: number;
}

/**
 * Rank the escalated ranchers into a call queue, best call first.
 *
 * Dropped entirely: rows with no escalation stamp, admin-parked ranchers, and
 * rows that have progressed past every stuck bucket. Ties break on days-stuck
 * (longest-ignored first), then id so the list never reshuffles between
 * renders.
 */
export function rankStuckRancherQueue(
  rows: StuckRancherRow[],
  { now, limit = DEFAULT_STUCK_QUEUE_LIMIT }: RankStuckOptions,
): StuckQueueResult {
  let parkedCount = 0;
  let resolvedCount = 0;
  const scored: RankedStuckRancherRow[] = [];

  for (const row of rows) {
    if (!String(row.stuckEscalatedAt || '').trim()) continue;
    if (isParked(row)) {
      parkedCount++;
      continue;
    }
    const s = scoreStuckRancher(row, now);
    if (s.bucket === 'resolved') {
      resolvedCount++;
      continue;
    }
    scored.push({ ...row, ...s });
  }

  scored.sort(
    (a, b) => b.score - a.score || b.daysStuck - a.daysStuck || a.id.localeCompare(b.id),
  );

  return {
    rows: scored.slice(0, Math.max(0, limit)),
    parkedCount,
    resolvedCount,
    totalStuck: scored.length,
  };
}
