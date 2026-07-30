// lib/buyerDealStage.ts
//
// WAVE 3 (2026-07-30) — the BUYER's model of their own deal.
//
// A buyer who wired $650–$2,500 opens /member and, until tonight, saw a status
// badge and two disjoint sentences. This module turns the referral's scattered
// Airtable stamps into ONE ordered ladder the buyer can read at a glance:
//
//   deposit paid → rancher accepted → scheduled → ready → balance → delivered
//
// NOT lib/buyerTimeline.ts. That module merges N event sources into a
// chronological admin feed (emails, calls, funnel events); it has no notion of
// "where is this deal". This one is a stage model and nothing else.
//
// PURE — zero I/O, so the whole ladder is unit-testable without Airtable
// (lib/buyerDealStage.test.ts). The route (/api/member/content) shapes the
// referral row into BuyerDealFields; the page renders what comes back.
//
// TWO INVARIANTS the tests pin:
//   1. At most ONE step is `current`, and it is the first not-done step.
//   2. The ladder is MONOTONE — a later signal backfills every earlier step to
//      `done`. Airtable stamps arrive out of order constantly (a rancher can
//      jump the tracker straight to `ready` without ever typing a Handoff
//      Date), and a stepper with a hole in it reads as broken, not as honest.

import { isDepositAlreadyPaid } from './depositPaidState';

export type BuyerDealStepState = 'done' | 'current' | 'upcoming';

export type BuyerDealStepKey =
  | 'deposit'
  | 'accepted'
  | 'scheduled'
  | 'ready'
  | 'balance'
  | 'delivered';

export const BUYER_DEAL_STEP_KEYS: readonly BuyerDealStepKey[] = [
  'deposit',
  'accepted',
  'scheduled',
  'ready',
  'balance',
  'delivered',
] as const;

export interface BuyerDealStep {
  key: BuyerDealStepKey;
  label: string;
  state: BuyerDealStepState;
  /** Raw date/datetime string for this step when one is known ('' otherwise). */
  date?: string;
  /** One honest sentence about THIS step in THIS state. */
  detail?: string;
}

/**
 * The referral fields this model reads. camelCase on purpose — the Airtable
 * field names live in exactly one place (the member content route +
 * FULFILLMENT_FIELDS), never duplicated here.
 */
export interface BuyerDealFields {
  status?: string;
  depositPaidAt?: string;
  depositRequestedAt?: string;
  depositAmount?: number;
  rancherAcceptedAt?: string;
  handoffDate?: string;
  processingDate?: string;
  fulfillmentStatus?: string;
  fulfillmentMethod?: string;
  buyerFulfillmentPref?: string;
  finalInvoiceSentAt?: string;
  finalInvoiceAmount?: number;
  finalPaidAt?: string;
  fulfillmentConfirmedAt?: string;
  /** Display name used inside step details ('your rancher' when absent). */
  rancherName?: string;
}

// Statuses that mean the deal is over WITHOUT completing — a progress ladder
// on a refunded or lost deal is worse than no ladder at all.
const DEAD_STATUSES = new Set(['Closed Lost', 'Lost', 'Refunded', 'Rejected']);

const s = (v: unknown): string => String(v ?? '').trim();

// ── handoff wording — ONE source, shared with the buyer handoff email ────────
//
// The pickup-vs-delivery precedence was written for Wave 2's
// sendBuyerHandoffScheduled (the rancher's own Fulfillment Method wins;
// the buyer's stated Buyer Fulfillment Pref is the fallback; neither → the
// generic word). The buyer's READ side needs the identical rule, so it lives
// here and lib/email.ts imports handoffWord() rather than re-deriving it.

export type HandoffMode = 'pickup' | 'delivery' | null;

export function resolveHandoffMode(input: {
  /** Referral 'Fulfillment Method' — 'pickup' | 'ship'. */
  method?: string;
  /** Referral 'Buyer Fulfillment Pref' — 'Pickup' | 'Delivery'. */
  buyerPref?: string;
}): HandoffMode {
  const method = s(input.method).toLowerCase();
  if (method === 'pickup') return 'pickup';
  if (method === 'ship') return 'delivery';
  const pref = s(input.buyerPref).toLowerCase();
  if (pref === 'pickup') return 'pickup';
  if (pref === 'delivery') return 'delivery';
  return null;
}

/** The exact noun the buyer handoff email uses. */
export function handoffWord(mode: HandoffMode): 'pickup' | 'delivery' | 'handoff' {
  return mode === 'pickup' ? 'pickup' : mode === 'delivery' ? 'delivery' : 'handoff';
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** $1,499.50 — the buyer sees cents, because an invoice has cents. */
export function formatMoney(amount: number): string {
  return `$${Number(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function who(fields: BuyerDealFields): string {
  return s(fields.rancherName) || 'your rancher';
}

// ── per-step "is this done" predicates ──────────────────────────────────────

function depositDone(f: BuyerDealFields): boolean {
  // Reuse the canonical guard rather than reading Status directly — 'Awaiting
  // Payment' is overloaded (written both BEFORE and AFTER the buyer pays), and
  // getting that wrong is exactly the 2026-07-14 bricked-buyer bug.
  return isDepositAlreadyPaid({
    Status: f.status,
    'Deposit Paid At': f.depositPaidAt,
    'Deposit Requested At': f.depositRequestedAt,
  });
}

function acceptedDone(f: BuyerDealFields): boolean {
  return !!s(f.rancherAcceptedAt) || s(f.status) === 'Slot Locked';
}

function scheduledDone(f: BuyerDealFields): boolean {
  if (s(f.handoffDate)) return true;
  // The rancher moving the tracker to processing-or-beyond means scheduling is
  // behind them, even if they never typed a Handoff Date.
  const st = s(f.fulfillmentStatus).toLowerCase();
  return st === 'processing' || st === 'ready' || st === 'fulfilled';
}

function readyDone(f: BuyerDealFields): boolean {
  const st = s(f.fulfillmentStatus).toLowerCase();
  return st === 'ready' || st === 'fulfilled' || !!s(f.fulfillmentConfirmedAt);
}

function balanceDone(f: BuyerDealFields): boolean {
  return !!s(f.finalPaidAt) || s(f.status) === 'Closed Won';
}

function deliveredDone(f: BuyerDealFields): boolean {
  // 'Closed Won' counts. It is the platform's terminal "this deal completed"
  // state and the buyer's own order card already reads "your beef has been
  // delivered" — a stepper that disagreed with the badge two inches above it
  // would manufacture the very confusion this wave exists to remove.
  return (
    !!s(f.fulfillmentConfirmedAt) ||
    s(f.fulfillmentStatus).toLowerCase() === 'fulfilled' ||
    s(f.status) === 'Closed Won'
  );
}

const STEP_DEFS: {
  key: BuyerDealStepKey;
  label: string;
  isDone: (f: BuyerDealFields) => boolean;
}[] = [
  { key: 'deposit', label: 'Deposit paid', isDone: depositDone },
  { key: 'accepted', label: 'Rancher accepted', isDone: acceptedDone },
  { key: 'scheduled', label: 'Scheduled', isDone: scheduledDone },
  { key: 'ready', label: 'Ready', isDone: readyDone },
  { key: 'balance', label: 'Final balance', isDone: balanceDone },
  { key: 'delivered', label: 'Delivered', isDone: deliveredDone },
];

// ── per-step date + detail ──────────────────────────────────────────────────

function stepDate(key: BuyerDealStepKey, f: BuyerDealFields): string {
  switch (key) {
    case 'deposit':
      return s(f.depositPaidAt);
    case 'accepted':
      return s(f.rancherAcceptedAt);
    case 'scheduled':
      return s(f.handoffDate);
    case 'ready':
      return s(f.processingDate);
    case 'balance':
      return s(f.finalPaidAt) || s(f.finalInvoiceSentAt);
    case 'delivered':
      return s(f.fulfillmentConfirmedAt);
  }
}

function stepDetail(
  key: BuyerDealStepKey,
  state: BuyerDealStepState,
  f: BuyerDealFields,
): string {
  const mode = resolveHandoffMode({ method: f.fulfillmentMethod, buyerPref: f.buyerFulfillmentPref });
  const word = handoffWord(mode);
  const name = who(f);

  switch (key) {
    case 'deposit':
      if (state === 'done') {
        return f.depositAmount
          ? `Deposit of ${formatMoney(f.depositAmount)} received.`
          : 'Deposit received.';
      }
      return 'Your slot is not held until the deposit lands.';

    case 'accepted':
      if (state === 'done') return `${name} committed your processing slot.`;
      if (state === 'current') {
        // Verbatim carry-over of the /member "waiting for X to accept your
        // slot / you'll get an email the moment it locks" wording that used to
        // float under the card. Same promise, now attached to its own step.
        return `Waiting on ${name} to accept your slot. You get an email the moment it locks, and your deposit stays fully refundable until then.`;
      }
      return '';

    case 'scheduled':
      if (state === 'done' && s(f.handoffDate)) return `${titleCase(word)} scheduled.`;
      // Past scheduling with no date on record — say exactly that rather than
      // implying a date exists somewhere the buyer cannot see.
      if (state === 'done') return `No ${word} date on record — ${name} is coordinating it with you directly.`;
      if (state === 'current') return `${name} has not set your ${word} date yet.`;
      return '';

    case 'ready': {
      const st = s(f.fulfillmentStatus).toLowerCase();
      if (state === 'done') {
        return mode === 'pickup'
          ? 'Cut, wrapped, and ready for pickup.'
          : mode === 'delivery'
            ? 'Cut, wrapped, and ready to go out.'
            : 'Cut, wrapped, and ready.';
      }
      if (state === 'current') {
        return st === 'processing'
          ? 'At the processor now.'
          : `${name} takes it to the processor — that is where the wait usually sits.`;
      }
      return '';
    }

    case 'balance':
      if (state === 'done') return 'Balance paid in full.';
      if (state === 'current') {
        return f.finalInvoiceAmount
          ? `Final balance of ${formatMoney(f.finalInvoiceAmount)} due — it goes straight to ${name}.`
          : `${name} sends your final balance once the hanging weight is known.`;
      }
      return '';

    case 'delivered':
      if (state === 'done') return 'Beef delivered.';
      if (state === 'current') return `Last step — ${word} with ${name}.`;
      return '';
  }
}

// ── the ladder ──────────────────────────────────────────────────────────────

/**
 * Build the six-step buyer ladder. Always returns all six steps in order — the
 * caller decides whether to render it (see shouldShowDealLadder).
 */
export function buildBuyerDealLadder(fields: BuyerDealFields | null | undefined): BuyerDealStep[] {
  const f = fields || {};
  const done = STEP_DEFS.map((def) => def.isDone(f));

  // Monotone backfill: any done step forces every earlier step done.
  let seenDone = false;
  for (let i = done.length - 1; i >= 0; i--) {
    if (done[i]) seenDone = true;
    else if (seenDone) done[i] = true;
  }

  const currentIdx = done.indexOf(false);

  return STEP_DEFS.map((def, i) => {
    const state: BuyerDealStepState = done[i] ? 'done' : i === currentIdx ? 'current' : 'upcoming';
    const step: BuyerDealStep = { key: def.key, label: def.label, state };
    const date = stepDate(def.key, f);
    if (date) step.date = date;
    const detail = stepDetail(def.key, state, f);
    if (detail) step.detail = detail;
    return step;
  });
}

/** The one live step, or null when the whole ladder is done. */
export function currentStep(fields: BuyerDealFields | null | undefined): BuyerDealStep | null {
  return buildBuyerDealLadder(fields).find((step) => step.state === 'current') || null;
}

/**
 * Render the ladder only for a deposit-paid deal that has not died. Before the
 * deposit there is nothing to track (the card shows the pay CTA); after a
 * refund or a loss, a progress bar is a lie.
 */
export function shouldShowDealLadder(fields: BuyerDealFields | null | undefined): boolean {
  if (!fields) return false;
  if (DEAD_STATUSES.has(s(fields.status))) return false;
  return depositDone(fields);
}

// ── "what happens next", driven by the current step ─────────────────────────
//
// The single best artifact in the whole buyer flow is the honest Today / This
// week / When ready block on /checkout/[refId]/success — and a buyer sees it
// exactly once, the minute they pay. This is the same block, except it is
// keyed off the CURRENT step, so it stays true as the deal moves instead of
// freezing at day one.

export interface NextStepLine {
  /** 'Today' / 'This week' / 'When ready' — the timeframe column. */
  when: string;
  text: string;
}

export function nextStepGuidance(
  fields: BuyerDealFields | null | undefined,
  opts: { rancherName?: string } = {},
): NextStepLine[] {
  const f = { ...(fields || {}), rancherName: opts.rancherName || fields?.rancherName };
  const name = who(f);
  const word = handoffWord(
    resolveHandoffMode({ method: f.fulfillmentMethod, buyerPref: f.buyerFulfillmentPref }),
  );
  const step = currentStep(f);

  switch (step?.key) {
    case 'deposit':
      return [
        { when: 'Now', text: `Reserve your share. Nothing is held for you until the deposit lands.` },
        { when: 'Within 24 to 48 hours', text: `${name} accepts your slot. Until they do, your deposit is fully refundable.` },
        { when: 'After that', text: `You and ${name} settle the date, the location, and the cut sheet.` },
      ];

    case 'accepted':
      return [
        { when: 'Today', text: `We told ${name} your deposit landed, by email and by text. They reach out directly, usually the same day.` },
        { when: 'This week', text: `${name} accepts your slot and commits your processing date. Your deposit stays fully refundable until then.` },
        { when: 'After that', text: `You settle ${word} details in your message thread, then pay the balance when the final weight is known.` },
      ];

    case 'scheduled':
      return [
        { when: 'Now', text: `${name} is booking your processing slot.` },
        { when: 'Next', text: `The moment your ${word} date is set, we email you and it shows up right here.` },
        { when: 'When ready', text: `You pay the final balance, then ${word === 'pickup' ? 'pick your beef up' : 'take delivery'}.` },
      ];

    case 'ready':
      return [
        { when: 'Now', text: `Your beef is being cut and wrapped. This is where the wait usually sits.` },
        { when: 'Next', text: `${name} sends the final balance once the hanging weight is known. It goes straight to them.` },
        { when: `On ${word} day`, text: word === 'pickup' ? 'Bring a cooler or two. Vacuum-sealed packs travel fine for the drive home.' : 'Be around to get the box into a freezer promptly.' },
      ];

    case 'balance':
      return [
        { when: 'Now', text: `Pay the final balance. One hundred percent of it goes to ${name}.` },
        { when: 'Then', text: `${name} confirms your ${word} and hands off your beef.` },
      ];

    case 'delivered':
      return [
        { when: 'Now', text: `Everything is paid. ${name} coordinates the ${word} with you directly.` },
        { when: `On ${word} day`, text: word === 'pickup' ? 'Bring a cooler or two, and clear the freezer space before you go.' : 'Be around to get the box into a freezer promptly.' },
      ];

    default:
      return [
        { when: 'All done', text: `Your order is complete. Reorder from ${name} any time, or leave them a review.` },
      ];
  }
}
