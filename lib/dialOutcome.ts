// lib/dialOutcome.ts
//
// C1 — dial-outcome write-back (cockpit CRM-parity,
// docs/ADAPTIVE-MARKETING-DESIGN.md §3.5). The cockpit dial list was
// fire-and-forget: Ben called, nothing was stamped, and tomorrow's queue
// re-ranked off nothing. This module derives WHICH FIELDS an outcome tap
// writes, per row kind — the endpoint (app/api/admin/dial-outcome) stays a
// thin applier.
//
// Every field name below is verified against the live Airtable schema
// (2026-08-10) and its existing writers:
//   Consumers 'Last Contacted'      dateTime fldRT9Tu9E96NbzYp — the admin
//     contact stamp (/api/admin/follow-ups 'done' is the template). NOT
//     'Last Contacted At' (date) — see that endpoint's landmine note.
//   Consumers 'Next Follow Up At'   date fldLpCco9KGJf1LxN — the promise rail
//     (lib/followUpQueue owns "due"; validateFollowUpDate owns "writable").
//   Consumers 'Callback Handled At' dateTime flddhpbUS5p2k1OlN — clears an
//     open callback (app/api/admin/callbacks/[id]/handled is the template).
//   Referrals 'Last Chased At'      dateTime — head of closeQueue's staleness
//     chain AND referral-chasup's suppression stamp. WRITE-MAP already calls
//     it OVERLOADED ("chased" ≡ "operator dismissed") — the telegram
//     'chaskip' button stamps it purely to suppress tomorrow's cron, and a
//     dial outcome is the same kind of operator-touch truth. 'Chase Count' is
//     deliberately NOT incremented: that counter is the EMAIL-chase budget
//     (MAX_CHASE_UPS) and a phone tap must not consume it.
//   Ranchers  'Last Touch At' dateTime fldwftfiDQKUHykMe + 'Last Touch Note'
//     multilineText fldFTWU1qJz7rrN74 — display-only in this repo
//     (stuckRancherQueue's neverWorked flag). A dial IS a touch; the note
//     records which kind so the stamp stays auditable.
//
// THE OUTCOME MATRIX (why each write):
//   no-answer → Next Follow Up At = today+1 (buyer/promise rows): the retry
//     becomes a tracked promise instead of a memory. No 'Last Contacted' —
//     nobody was contacted, and that stamp feeds the demand-router's
//     marketing cooldown (an unanswered dial must not pause email, which is
//     exactly the channel to try next).
//   talked    → 'Last Contacted' now (+ clears an open callback, + optional
//     follow-up promise at 3/7 days).
//   skip      → a DEFER, not a delete. Buyers: Next Follow Up At = today+7.
//     Promises: promise cleared. Dropping a buyer/deal outright is a lane /
//     close-detector decision the machine owns (docs/OPERATOR-LOOP.md
//     ENTRY 5) — a one-tap on the dial list is not allowed to close anything.
//
// PURE: no I/O, no Date.now() (the caller passes now/today), no mutation.

import { snoozeFollowUpDate, validateFollowUpDate } from './followUpQueue';

export const DIAL_OUTCOMES = ['no-answer', 'talked', 'skip'] as const;
export type DialOutcome = (typeof DIAL_OUTCOMES)[number];

export const DIAL_OUTCOME_KINDS = ['buyer', 'promise', 'deal', 'rancher'] as const;
export type DialOutcomeKind = (typeof DIAL_OUTCOME_KINDS)[number];

/** no-answer retries tomorrow; skip defers a week. Both surface as promises. */
export const NO_ANSWER_RETRY_DAYS = 1;
export const SKIP_DEFER_DAYS = 7;
/** "Talked, follow up in N days" choices offered by the cockpit UI. */
export const TALKED_FOLLOW_UP_DAYS = [3, 7] as const;

// Field names (see header for verification).
export const F_LAST_CONTACTED = 'Last Contacted';
export const F_NEXT_FOLLOW_UP_AT = 'Next Follow Up At';
export const F_CALLBACK_HANDLED_AT = 'Callback Handled At';
export const F_LAST_CHASED_AT = 'Last Chased At';
export const F_LAST_TOUCH_AT = 'Last Touch At';
export const F_LAST_TOUCH_NOTE = 'Last Touch Note';

export interface DialOutcomePlanInput {
  kind: DialOutcomeKind;
  outcome: DialOutcome;
  /** ISO dateTime for the dateTime stamps. */
  nowIso: string;
  /** Operator's calendar day 'YYYY-MM-DD' (lib/followUpQueue.operatorToday). */
  today: string;
  /** Buyer rows: is there an open callback request to close on talk/skip? */
  hasOpenCallback?: boolean;
  /** talked only: promise a follow-up in N days (3 or 7). */
  followUpDays?: number;
  /** buyer rows: a linked referral exists (deposit-opened tier) to chase-stamp. */
  hasReferral?: boolean;
}

export interface DialOutcomePlan {
  /** Consumers writes (null clears a field). */
  consumer?: Record<string, string | null>;
  /** Referrals writes. */
  referral?: Record<string, string>;
  /** Ranchers writes. */
  rancher?: Record<string, string>;
  /** One-line receipt of what was stamped, for the API response. */
  summary: string;
}

export type DialOutcomePlanResult =
  | { ok: true; plan: DialOutcomePlan }
  | { ok: false; error: string };

/** today+N as a validated 'YYYY-MM-DD', or null when the arithmetic fails. */
function followUpDate(today: string, days: number): string | null {
  const next = snoozeFollowUpDate(today, days);
  const v = validateFollowUpDate(next, today);
  return v.ok ? v.value : null;
}

export function planDialOutcome(input: DialOutcomePlanInput): DialOutcomePlanResult {
  const { kind, outcome, nowIso, today } = input;

  if (!(DIAL_OUTCOME_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `kind must be one of ${DIAL_OUTCOME_KINDS.join(', ')}` };
  }
  if (!(DIAL_OUTCOMES as readonly string[]).includes(outcome)) {
    return { ok: false, error: `outcome must be one of ${DIAL_OUTCOMES.join(', ')}` };
  }
  if (!nowIso || !today) {
    return { ok: false, error: 'nowIso and today are required' };
  }
  if (
    input.followUpDays != null &&
    !(TALKED_FOLLOW_UP_DAYS as readonly number[]).includes(input.followUpDays)
  ) {
    return {
      ok: false,
      error: `followUpDays must be one of ${TALKED_FOLLOW_UP_DAYS.join(', ')}`,
    };
  }
  if (input.followUpDays != null && outcome !== 'talked') {
    return { ok: false, error: 'followUpDays only applies to a talked outcome' };
  }

  const summaryBits: string[] = [];
  const plan: DialOutcomePlan = { summary: '' };

  // ── rancher rows — a touch stamp + a note naming which kind ─────────────
  if (kind === 'rancher') {
    const noteByOutcome: Record<DialOutcome, string> = {
      'no-answer': 'no answer',
      talked: 'talked',
      skip: 'skipped',
    };
    plan.rancher = {
      [F_LAST_TOUCH_AT]: nowIso,
      [F_LAST_TOUCH_NOTE]: `dial: ${noteByOutcome[outcome]} (cockpit ${today})`,
    };
    plan.summary = `rancher ${noteByOutcome[outcome]} — Last Touch At stamped`;
    return { ok: true, plan };
  }

  // ── deal rows — the chase stamp; closeQueue staleness resets off it ─────
  if (kind === 'deal') {
    plan.referral = { [F_LAST_CHASED_AT]: nowIso };
    summaryBits.push('Last Chased At stamped');
    if (outcome === 'talked' && input.followUpDays != null) {
      const due = followUpDate(today, input.followUpDays);
      if (!due) return { ok: false, error: 'could not derive the follow-up date' };
      plan.consumer = { [F_NEXT_FOLLOW_UP_AT]: due };
      summaryBits.push(`follow-up promised ${due}`);
    }
    plan.summary = `deal ${outcome} — ${summaryBits.join(', ')}`;
    return { ok: true, plan };
  }

  // ── buyer / promise rows — Consumers stamps ─────────────────────────────
  const consumer: Record<string, string | null> = {};

  if (outcome === 'talked') {
    consumer[F_LAST_CONTACTED] = nowIso;
    summaryBits.push('Last Contacted stamped');
    if (input.hasOpenCallback) {
      consumer[F_CALLBACK_HANDLED_AT] = nowIso;
      summaryBits.push('callback closed');
    }
    if (input.followUpDays != null) {
      const due = followUpDate(today, input.followUpDays);
      if (!due) return { ok: false, error: 'could not derive the follow-up date' };
      consumer[F_NEXT_FOLLOW_UP_AT] = due;
      summaryBits.push(`follow-up promised ${due}`);
    } else if (kind === 'promise') {
      // Promise kept, no new one made — stop it coming due (the follow-ups
      // endpoint's 'done' semantics).
      consumer[F_NEXT_FOLLOW_UP_AT] = null;
      summaryBits.push('promise cleared');
    }
  } else if (outcome === 'no-answer') {
    const due = followUpDate(today, NO_ANSWER_RETRY_DAYS);
    if (!due) return { ok: false, error: 'could not derive the retry date' };
    consumer[F_NEXT_FOLLOW_UP_AT] = due;
    summaryBits.push(`retry promised ${due}`);
  } else {
    // skip
    if (kind === 'promise') {
      consumer[F_NEXT_FOLLOW_UP_AT] = null;
      summaryBits.push('promise dropped');
    } else {
      const due = followUpDate(today, SKIP_DEFER_DAYS);
      if (!due) return { ok: false, error: 'could not derive the defer date' };
      consumer[F_NEXT_FOLLOW_UP_AT] = due;
      summaryBits.push(`deferred to ${due}`);
    }
    if (input.hasOpenCallback) {
      consumer[F_CALLBACK_HANDLED_AT] = nowIso;
      summaryBits.push('callback closed');
    }
  }

  plan.consumer = consumer;

  // Deposit-opened buyer rows carry a live referral: every outcome also
  // resets its chase clock (same OVERLOADED 'Last Chased At' semantics as the
  // telegram chaskip button — "an operator touched this today").
  if (kind === 'buyer' && input.hasReferral) {
    plan.referral = { [F_LAST_CHASED_AT]: nowIso };
    summaryBits.push('referral chase clock reset');
  }

  plan.summary = `${kind} ${outcome} — ${summaryBits.join(', ')}`;
  return { ok: true, plan };
}
