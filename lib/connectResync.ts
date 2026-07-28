// lib/connectResync.ts
//
// Pure decision logic for re-syncing a rancher's cached Stripe Connect status
// from a LIVE Stripe read. Split into its own ZERO-import module (no Stripe
// client, no Airtable, no secrets chain) so it can be unit-tested under the
// repo's standard `npm test` harness (lib/**/*.test.ts).
//
// Background: the only writer of `Stripe Connect Status = 'active'` in normal
// flow is the account.updated webhook. If that event fired before the Connect
// account was merged onto its canonical Ranchers row, or simply never reached
// us, the row stays stuck at 'onboarding'/'not_connected' even though Stripe
// has charges_enabled. The dashboard reads that stale cache, so the rancher
// sees a "connect your bank" banner forever with no self-serve way out.
//
// Both the admin resync endpoint and the new rancher-side resync compute the
// SAME write fields + side effects from a live read. This module factors out
// that decision so the two callers stay in lockstep and the money/migration
// invariants are testable in isolation.

import type { ConnectAccountStatus } from './connectStatusClassify';

export interface ConnectResyncInput {
  /** Live `status` from getConnectAccountStatus(). */
  liveStatus: ConnectAccountStatus;
  /** Current cached value of the Airtable `Stripe Connect Status` field. */
  previousStatus: string;
  /** Truthy when `Stripe Connect Connected At` is already stamped. */
  alreadyConnectedAt: boolean;
  /** Airtable `Pricing Model` (case-insensitive). */
  pricingModel: string;
  /** Airtable `Migration Status` (case-insensitive). */
  migrationStatus: string;
  /** ISO timestamp to stamp on first active-flip. Injected for testability. */
  nowISO: string;
}

export interface ConnectResyncDecision {
  /** True when the live status differs from the cache → an Airtable write is needed. */
  changed: boolean;
  /** True when the live status is 'active' (deposits flow). */
  isNowActive: boolean;
  /** Fields to write to the Ranchers row. Empty object when !changed. */
  writeFields: Record<string, any>;
  /** True when this resync advances the tier_v2 migration tracker to completed. */
  migrationCompleted: boolean;
  /**
   * True when Connect flipped active on a rancher the migration-deadline cron
   * auto-paused (Migration Status='paused_overdue'). No generic rail unpauses
   * Active Status='Paused' (webhook auto-go-live excludes Onboarding
   * Status='Live'; go-live-sync excludes Paused).
   *
   * Callers MUST do one of two things or the rancher finishes the upgrade and
   * silently receives zero buyers forever:
   *   1. `shouldAutoResumePausedOverdue` is true (tier_v2 + Connect live) →
   *      auto-resume via lib/pauseReversal; NO operator button needed.
   *   2. otherwise → fire the loud operator signal WITH the one-tap unpause.
   */
  wasPausedOverdue: boolean;
}

// Migration states that are not yet "done" — an active Connect flip advances
// these to 'completed'. Mirrors app/api/admin/ranchers/[id]/resync-connect.
// 'paused_overdue' included (2026-07-21): a deadline-paused rancher who then
// finishes Connect HAS completed the migration — leaving the tracker at
// paused_overdue misreports /admin/migration and hides the unpause need.
const INCOMPLETE_MIGRATION = new Set([
  '',
  'not_invited',
  'invited',
  'call_scheduled',
  'upgrading',
  'paused_overdue',
]);

/**
 * Compute the Airtable write-back for a Connect status resync. Read-derived:
 * mirrors exactly what the account.updated webhook would have written. No money
 * mutation — flips a status field and (on active-flip) advances the migration
 * tracker. Idempotent: when liveStatus already matches the cache, changed=false
 * and writeFields is empty so the caller can skip the write.
 */
export function computeConnectResync(input: ConnectResyncInput): ConnectResyncDecision {
  const isNowActive = input.liveStatus === 'active';
  const migStatus = String(input.migrationStatus || '').toLowerCase();
  const wasPausedOverdue = isNowActive && migStatus === 'paused_overdue';

  if (input.previousStatus === input.liveStatus) {
    return { changed: false, isNowActive, writeFields: {}, migrationCompleted: false, wasPausedOverdue };
  }

  const writeFields: Record<string, any> = { 'Stripe Connect Status': input.liveStatus };
  if (isNowActive && !input.alreadyConnectedAt) {
    writeFields['Stripe Connect Connected At'] = input.nowISO;
  }

  const pricingModel = String(input.pricingModel || '').toLowerCase();
  const migrationCompleted =
    isNowActive && pricingModel === 'tier_v2' && INCOMPLETE_MIGRATION.has(migStatus);
  if (migrationCompleted) {
    writeFields['Migration Status'] = 'completed';
  }

  return { changed: true, isNowActive, writeFields, migrationCompleted, wasPausedOverdue };
}

// ---------------------------------------------------------------------------
// NIGHTLY RECONCILE WRITE POLICY (2026-07-25)
// ---------------------------------------------------------------------------
// app/api/cron/stripe-reconcile ran DRY-RUN by default and only wrote with
// ?apply=1 — and its vercel.json entry is a bare path, so it never healed
// anything in its life. The two classes it reconciles are NOT equally risky:
//
//   CONNECT   — copies a fact Stripe already considers true (charges_enabled →
//               'Stripe Connect Status') into BHC's cache. No pricing, no
//               billing, no comms. Exactly what the account.updated webhook
//               would have written. Safe to heal unattended.
//   SUBS      — touches 'Tier' and 'Subscription Status', which drive the
//               commission rate and the billing rails. Stays observe-only on
//               the schedule; ?apply=1 is the manual escape hatch so the
//               founder can watch a few nights of "would heal" first.
//
// Split here (pure) rather than inline in the route so the policy is testable
// and there is exactly one place to flip SUBS on later.

export interface ReconcileWritePolicy {
  /** Connect account status cache → Airtable. */
  connect: boolean;
  /** Tier / Subscription Status / Stripe Subscription Id → Airtable. */
  subscriptions: boolean;
}

/**
 * @param manualApply true when the caller passed `?apply=1` (a human at a
 *        terminal, per bhc-mutation-guardrails). The scheduled Vercel cron
 *        never sets it.
 */
export function reconcileWritePolicy(manualApply: boolean): ReconcileWritePolicy {
  return { connect: true, subscriptions: manualApply };
}

// ---------------------------------------------------------------------------
// PAUSED-OVERDUE ESCALATION
// ---------------------------------------------------------------------------
// `wasPausedOverdue` alone is not enough to bother the founder: a rancher whose
// Active Status has ALREADY been flipped back to Active (or who is At Capacity)
// needs nothing. The escalation is exactly "Connect is live AND the row is
// still sitting at Paused". Mirrors the gate the stripe-connect webhook uses.

export function shouldEscalateUnpause(input: {
  /** From computeConnectResync. */
  wasPausedOverdue: boolean;
  /** Airtable 'Active Status' (already unwrapped from a {name} single-select). */
  activeStatus: string;
}): boolean {
  return (
    input.wasPausedOverdue &&
    String(input.activeStatus || '').trim().toLowerCase() === 'paused'
  );
}

// ---------------------------------------------------------------------------
// AUTO-REVERSE THE MACHINE'S OWN PAUSE (pause-asymmetry sweep 2026-07-25)
// ---------------------------------------------------------------------------
// FOUR code paths write Active Status='Paused'. ZERO ever wrote it back. The
// machine pauses itself automatically and resumes itself never — so a rancher
// who fixes the exact thing they were paused for stays dark forever.
//
// This reverses EXACTLY ONE of those four, and only because the machine can
// PROVE it set that pause itself and that its own stated reason is now gone:
//
//   PROVENANCE. `Migration Status = 'paused_overdue'` is written by exactly
//   ONE line in the codebase — app/api/cron/migration-deadline/route.ts, in
//   the same updateRecord() call that writes Active Status='Paused'. Nothing
//   else, human or machine, ever writes that value. Its presence on a Paused
//   row is therefore proof the migration-deadline cron caused that pause.
//
//   REASON EXPIRED. That cron's stated reason is "missed the tier_v2
//   migration deadline". The reason is demonstrably gone only when the
//   rancher HAS migrated: Pricing Model='tier_v2' AND Connect live. Connect
//   active alone is not enough — a legacy rancher with working Connect still
//   has not done the thing they were paused for, so they keep the button.
//
//   SINGLE USE. The resume write CONSUMES the marker (Migration Status →
//   'completed') in the same update that lifts the pause. After it fires once,
//   this predicate can never be true for that rancher again — so a pause a
//   HUMAN sets later can never be overridden by this rail. That property, not
//   the predicate alone, is what makes auto-reversal safe under repo rule #5.
//
// DELIBERATELY NOT REVERSED (each fails the two tests above):
//   · pilot-goal pause (cron/nightly-rancher-audit, api/rancher/referrals) —
//     "you hit your goal, let's talk volume" is a founder conversation, not an
//     expired machine condition. No marker, and the reason never expires.
//   · compliance pause (Active Status='Non-Compliant') — a human/verification
//     judgement; never reads as 'Paused' anyway.
//   · Connect DEAUTHORIZE pause (webhooks/stripe-connect) — NO usable
//     provenance marker survives the fix. It stamps Stripe Connect
//     Status='detached', but re-onboarding OVERWRITES that to 'active', and
//     'Connect Detached At' is never cleared — so a row that detached months
//     ago, was resumed, and was later paused BY A HUMAN is byte-identical to
//     one still machine-paused for the detach. Cannot distinguish → left
//     manual, on purpose. It keeps the one-tap Telegram button.
//   · admin pause (api/admin/ranchers/[id]/pause) — human by definition; it
//     also stamps '[PAUSED <date> — reason]' into Verification Notes.

export interface AutoResumeInput {
  /** LIVE Connect truth (not the Airtable cache) — deposits actually flow. */
  connectIsActive: boolean;
  /** Airtable 'Pricing Model'. */
  pricingModel: string;
  /** Airtable 'Migration Status' — carries the provenance marker. */
  migrationStatus: string;
  /** Airtable 'Active Status' (unwrapped from a {name} single-select). */
  activeStatus: string;
}

/**
 * Pure. True ONLY for a pause this machine set via the migration-deadline cron
 * whose stated reason has since expired. Every other pause returns false.
 */
export function shouldAutoResumePausedOverdue(input: AutoResumeInput): boolean {
  const migrationDeadlinePausedIt =
    String(input.migrationStatus || '').trim().toLowerCase() === 'paused_overdue';
  const stillPaused = String(input.activeStatus || '').trim().toLowerCase() === 'paused';
  const migrationActuallyDone =
    input.connectIsActive === true &&
    String(input.pricingModel || '').trim().toLowerCase() === 'tier_v2';
  return migrationDeadlinePausedIt && stillPaused && migrationActuallyDone;
}

/**
 * Pure. The Airtable write that lifts the pause.
 *
 * Capacity-aware, mirroring /api/admin/ranchers/[id]/resume exactly — a
 * rancher already at their cap returns to 'At Capacity', NOT a bare 'Active',
 * so the matcher cannot over-fill them the moment the pause lifts.
 *
 * Always carries Migration Status='completed': that is the marker consumption
 * that makes this single-use (see above). Never write the Active Status flip
 * without it.
 */
export function buildPausedOverdueResumeFields(input: {
  heldReferrals: number;
  maxReferrals: number;
}): { 'Active Status': 'Active' | 'At Capacity'; 'Migration Status': 'completed' } {
  const held = Number(input.heldReferrals) || 0;
  const cap = Number(input.maxReferrals) || 0;
  return {
    'Active Status': cap > 0 && held >= cap ? 'At Capacity' : 'Active',
    'Migration Status': 'completed',
  };
}

/**
 * Telegram callback prefix for the one-tap unpause button carried by the
 * 'UPGRADE COMPLETE — UNPAUSE …' operator signal. Handled in
 * app/api/webhooks/telegram (registered as a HIGH_RISK_PREFIX so a double-tap
 * can't double-write). Lives here so the emitters and the handler cannot drift.
 *
 * The button remains the founder's per-rancher OK (repo rule #5) for every
 * pause the machine CANNOT prove it caused — a legacy rancher with live
 * Connect, a Connect-deauthorize pause, anything a human set. Since
 * 2026-07-25 the one provable case (tier_v2 + Connect live + paused_overdue)
 * auto-resumes instead, and those ranchers no longer get a card at all — so
 * a button that appears is always a real decision, never a redundant one.
 */
export const UNPAUSE_CALLBACK_PREFIX = 'cxunpause_';

export function unpauseCallbackData(rancherId: string): string {
  return `${UNPAUSE_CALLBACK_PREFIX}${rancherId}`;
}
