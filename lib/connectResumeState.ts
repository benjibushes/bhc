// lib/connectResumeState.ts
//
// ONE honest answer to "where is this rancher stuck, and what do they do next?"
//
// Two pure concerns, both split out of lib/stripeConnect.ts so they unit-test
// with no Stripe client and no secrets chain:
//
//   1. dueRequirementsFromEntries() — read what Stripe is ACTUALLY blocking on
//      off a V2 account's `requirements.entries`.
//   2. connectHandoff() — collapse (account?, status, what's due) into the one
//      state + one next action the UI should render.
//
// ── WHY (1) EXISTS ─────────────────────────────────────────────────────────
// lib/stripeConnect.ts read the due list off `requirements.summary
// .currently_due`. On the V2 Accounts API that key DOES NOT EXIST — `summary`
// carries only `minimum_deadline` (verified against the pinned stripe@20.4.1
// types, V2/Core/Accounts.d.ts). So `currentlyDueCount` was computed as 0 on
// every account, forever. Everything downstream that promised the rancher
// "Stripe still needs N things" was reading a hardcoded zero.
//
// On V2 the real list is `requirements.entries[]`, each entry carrying a
// machine-readable `description`, an `awaiting_action_from` ('user' | 'stripe')
// and a per-entry `minimum_deadline.status`.
//
// NOTE for reviewers: making this count REAL can move a charges-disabled
// account from 'onboarding' to 'restricted' in classifyConnectStatus. That is
// safe for money by that module's own contract — anything != 'active' already
// closes the deposit gate, and isRancherOperationalForBuyers tests for
// 'active' exactly. It only sharpens the label.

import type { ConnectAccountStatus } from './connectStatusClassify';

/** Requirements Stripe is waiting on the RANCHER for, right now. */
const BLOCKING_STATUSES = new Set(['currently_due', 'past_due']);

/**
 * Extract the requirement descriptions the rancher must personally clear.
 *
 * Filters to entries awaiting action from the user (not the ones Stripe is
 * itself processing) whose deadline status is currently_due or past_due —
 * `eventually_due` is deliberately excluded: it isn't blocking them today and
 * listing it makes the remaining work look bigger than it is.
 *
 * Tolerant by construction: a missing/oddly-shaped payload yields []. Never
 * throws — this feeds a status read that must not fail on a schema drift.
 */
export function dueRequirementsFromEntries(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as any;
    if (e.awaiting_action_from && e.awaiting_action_from !== 'user') continue;
    const status = e?.minimum_deadline?.status;
    if (!BLOCKING_STATUSES.has(String(status))) continue;
    const desc = typeof e.description === 'string' ? e.description.trim() : '';
    if (desc && !out.includes(desc)) out.push(desc);
  }
  return out;
}

/**
 * The four states a rancher's payout hand-off can be in, as the UI should
 * think about them:
 *
 *   never_started — no Connect account exists yet. One button: start.
 *   incomplete    — Stripe has outstanding KYC a fresh onboarding link fixes.
 *                   This is where all five of our stalled ranchers sit.
 *   restricted    — blocked by something an onboarding link CANNOT clear
 *                   (a Stripe-side hold). Needs the dashboard/support.
 *   active        — done. Deposits land.
 */
export type ConnectHandoffState = 'never_started' | 'incomplete' | 'restricted' | 'active';

export interface ConnectHandoff {
  state: ConnectHandoffState;
  /** True when a fresh Stripe onboarding account-link is the correct fix. */
  canResume: boolean;
  /** How many things Stripe is blocking on. 0 when active or unknown. */
  currentlyDueCount: number;
  /** The machine-readable requirement list, for an honest "what's left". */
  currentlyDue: string[];
  /** One plain-English next action. Never blank. */
  nextAction: string;
}

export interface ConnectHandoffInput {
  /** Whether a Stripe Connect Account Id exists on the rancher record. */
  hasAccount: boolean;
  /** Live classification from classifyConnectStatus(). Null when unread. */
  status?: ConnectAccountStatus | null;
  /** Output of dueRequirementsFromEntries(). */
  currentlyDue?: string[];
  /** Routing hint from canResumeConnectOnboarding(). */
  canResumeOnboarding?: boolean;
}

/**
 * Collapse the Connect signals into ONE state and ONE next action.
 *
 * Pure. The UI (built in a follow-up PR) renders exactly this — it never
 * re-derives "is he stuck?" from a scatter of booleans, which is how the
 * dashboard came to show a rancher "live" while Stripe blocked every deposit.
 */
export function connectHandoff(input: ConnectHandoffInput): ConnectHandoff {
  const currentlyDue = Array.isArray(input.currentlyDue) ? input.currentlyDue : [];
  const currentlyDueCount = currentlyDue.length;

  if (!input.hasAccount) {
    return {
      state: 'never_started',
      canResume: false,
      currentlyDueCount: 0,
      currentlyDue: [],
      nextAction: 'Set up payouts with Stripe so buyers can pay you — about 5 minutes.',
    };
  }

  if (input.status === 'active') {
    return {
      state: 'active',
      canResume: false,
      currentlyDueCount: 0,
      currentlyDue: [],
      nextAction: "You're all set — deposits land straight in your account.",
    };
  }

  // A requirements-driven block is resumable with a fresh onboarding link.
  // Anything else on a restricted account needs the Stripe dashboard.
  const resumable =
    typeof input.canResumeOnboarding === 'boolean'
      ? input.canResumeOnboarding
      : input.status !== 'restricted' || currentlyDueCount > 0;

  if (input.status === 'restricted' && !resumable) {
    return {
      state: 'restricted',
      canResume: false,
      currentlyDueCount,
      currentlyDue,
      nextAction:
        'Stripe has placed a hold on your account that we can’t clear from here. Open your Stripe dashboard, or reply to this email and we’ll sort it with you.',
    };
  }

  return {
    state: 'incomplete',
    canResume: true,
    currentlyDueCount,
    currentlyDue,
    nextAction:
      currentlyDueCount > 0
        ? `Finish payout setup — Stripe still needs ${currentlyDueCount} thing${currentlyDueCount === 1 ? '' : 's'} from you.`
        : 'Finish payout setup with Stripe — about 5 minutes, then buyers can pay you.',
  };
}
