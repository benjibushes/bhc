// lib/appliedChase.ts
//
// THE APPLIED-COHORT CHASE — pure selector + touch-plan logic for
// app/api/cron/applied-chase/route.ts.
//
// WHO THIS RAIL OWNS: fresh Rancher APPLICATIONS — a row exists, Onboarding
// Status is blank or 'Docs Sent', the agreement is unsigned, and nobody has
// parked or escalated them. The two incumbent rails DO graze this cohort
// (rancher-followup's New Applicant path from day 2, onboarding-stuck's
// docs-sent bucket from day 3 — verified 2026-08-12 against both routes),
// but neither sends a day-0 welcome, neither carries the ONE-CLICK
// agreement-signing link (both push the setup-wizard token instead), and
// both go permanently silent after the day-14 terminal escalation. This rail
// closes those three gaps:
//
//   day 0 — welcome + one-click sign link + /pitch, on the first cron pass
//           after the application lands (age < 2 days).
//   day 2 — nudge (same links).
//   day 5 — last call (same links).
//   day 7 — hand to the human dial list: stamp Stuck Escalated At/Bucket,
//           which is exactly what /admin/today's stuck-rancher queue keys on
//           (lib/stuckRancherQueue — rows render with outcomeKind 'rancher').
//           The bucket written is the DERIVED one ('new-applicant' /
//           'docs-sent'), so deriveStuckBucket agrees and bucketDrifted
//           stays false.
//
// FIRST-SWEEP COVERAGE: a never-touched row enters the lane its AGE puts it
// in, not day 0 — the existing old 'Docs Sent' rows get ONE day-5 last-call
// each (oldest first, capped), never a day-0 "welcome" three weeks after
// they applied, and never the full three-email sequence.
//
// CROSS-RAIL DEDUP (the email-hygiene 2026-08-02 contract): this rail honors
// AND stamps the shared Ranchers field 'Last Onboarding Nudge At'. Any rail
// that touched the rancher inside 48h defers this rail's step WITHOUT
// advancing the stage (the step retries on a later run), and this rail's own
// stamp makes rancher-followup's ≥2-day throttle and onboarding-stuck's
// 4-day throttle back off symmetrically.
//
// PURE: no I/O, no Date.now() (callers pass `nowMs`), no input mutation.
// The caller applies excludeBrokerRanchers BEFORE planning (broker ranchers
// never applied — Ben recruited them; chasing them for a signature they were
// never sent is the exact bug the broker skip-lists exist to prevent).

import { isSyntheticTestEmail } from './demandRouter';

// ── Tuning constants ────────────────────────────────────────────────────────

/** Per-run ceiling across sends + handoffs — protects sender reputation and
 * bounds the first live sweep over the backlog. */
export const APPLIED_CHASE_MAX_TOUCHES_PER_RUN = 20;

/** Age gates for each lane (whole days since the row was created). */
export const DAY2_MIN_AGE_DAYS = 2;
export const DAY5_MIN_AGE_DAYS = 5;
/** Day-5 last-call sent + this much total age → hand to the dial list. */
export const HANDOFF_MIN_AGE_DAYS = 7;

/** Another onboarding rail touched them this recently → defer, don't stack. */
export const CROSS_RAIL_QUIET_MS = 48 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Field names (the Airtable boundary lives here) ──────────────────────────
//
// The two APPLIED_CHASE_* fields are NEW — lib/airtable's updateRecord
// auto-strips unknown fields (with a per-field operator alert), so a missing
// field degrades to "stage never persists → the row re-selects after the 48h
// cross-rail quiet window" rather than crashing the run. Create them before
// flipping the rail live (see the cron route header + PR body).

export const APPLIED_CHASE_STAGE_FIELD = 'Applied Chase Stage';
export const APPLIED_CHASE_TOUCH_AT_FIELD = 'Applied Chase Last Touch At';
/** Shared cross-rail throttle stamp — EXISTING field, written by
 * rancher-followup / onboarding-stuck / rancher-onboarding-drip. */
export const LAST_ONBOARDING_NUDGE_FIELD = 'Last Onboarding Nudge At';

// ── Types ───────────────────────────────────────────────────────────────────

export type AppliedChaseMode = 'off' | 'dry-run' | 'live';

export type AppliedChaseStage =
  | ''
  | 'day0-sent'
  | 'day2-sent'
  | 'day5-sent'
  | 'handed-off'
  | 'stopped';

export type AppliedChaseTouch = 'day0' | 'day2' | 'day5';

/** Dial-list bucket the handoff stamps — matches what
 * lib/stuckRancherQueue.deriveStuckBucket derives from the same fields, so
 * the queue never flags the row as bucket-drifted. */
export type AppliedChaseHandoffBucket = 'new-applicant' | 'docs-sent';

export interface AppliedChaseAction {
  id: string;
  ranchName: string;
  operatorName: string;
  email: string;
  state: string;
  ageDays: number;
  kind: 'send' | 'handoff';
  /** Present iff kind === 'send'. */
  touch?: AppliedChaseTouch;
  /** Stage to claim BEFORE the send (or 'handed-off' for handoffs). */
  nextStage: AppliedChaseStage;
  /** Stage on the row when planned — the send path's rollback target. */
  priorStage: AppliedChaseStage;
  /** Present iff kind === 'handoff'. */
  bucket?: AppliedChaseHandoffBucket;
  /** Handoffs only: the email channel is dead (missing/opted-out), so the
   * rail skipped straight past the email lanes to the human list. */
  emailDead?: boolean;
}

export interface AppliedChaseStop {
  id: string;
  ranchName: string;
  reason: string;
}

export interface AppliedChasePlan {
  /** Oldest application first, capped at `maxTouches`. */
  actions: AppliedChaseAction[];
  /** Rows with an active stage that have since left the cohort — flip their
   * stage to 'stopped' so they never re-select. Uncapped (cheap writes on a
   * bounded cohort — mirrors rancher-onboarding-drip's stop flips). */
  stops: AppliedChaseStop[];
  /** Skip-reason → count, for Cron Runs' Skip Reason Breakdown. */
  skips: Record<string, number>;
}

// ── Kill switch — tri-state, FAIL-TO-OFF (the campaign-autopilot contract) ──

export function appliedChaseMode(raw: string | undefined): AppliedChaseMode {
  if (raw === 'true') return 'live';
  if (raw === 'dry-run') return 'dry-run';
  return 'off';
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const str = (v: unknown): string => String(v ?? '').trim();

/** Active Status values that mean an admin deliberately parked the rancher
 * (mirrors rancher-followup's guard + the stale-lead branch's 'Removed'). */
const PARKED_ACTIVE = new Set(['Paused', 'Non-Compliant', 'Removed']);

export function whichTouchIsDue(
  stage: AppliedChaseStage,
  ageDays: number,
): AppliedChaseTouch | 'handoff' | null {
  switch (stage) {
    case '':
      if (ageDays >= DAY5_MIN_AGE_DAYS) return 'day5';
      if (ageDays >= DAY2_MIN_AGE_DAYS) return 'day2';
      return 'day0';
    case 'day0-sent':
      // A deferred day-2 that aged past the day-5 gate jumps lanes rather
      // than dragging the whole sequence — the lane is age-based.
      if (ageDays >= DAY5_MIN_AGE_DAYS) return 'day5';
      if (ageDays >= DAY2_MIN_AGE_DAYS) return 'day2';
      return null;
    case 'day2-sent':
      return ageDays >= DAY5_MIN_AGE_DAYS ? 'day5' : null;
    case 'day5-sent':
      return ageDays >= HANDOFF_MIN_AGE_DAYS ? 'handoff' : null;
    default:
      return null;
  }
}

const NEXT_STAGE: Record<AppliedChaseTouch, AppliedChaseStage> = {
  day0: 'day0-sent',
  day2: 'day2-sent',
  day5: 'day5-sent',
};

// ── The planner ─────────────────────────────────────────────────────────────

export function planAppliedChase(
  rows: ReadonlyArray<Record<string, unknown>>,
  nowMs: number,
  opts?: { maxTouches?: number },
): AppliedChasePlan {
  const maxTouches = opts?.maxTouches ?? APPLIED_CHASE_MAX_TOUCHES_PER_RUN;
  const skips: Record<string, number> = {};
  const skip = (reason: string): void => {
    skips[reason] = (skips[reason] || 0) + 1;
  };
  const stops: AppliedChaseStop[] = [];
  const eligible: Array<AppliedChaseAction & { createdMs: number }> = [];

  for (const r of rows) {
    const id = str((r as { id?: unknown }).id);
    if (!id) {
      skip('no-id');
      continue;
    }
    const ranchName = str(r['Ranch Name']) || str(r['Operator Name']) || 'Ranch';
    const stage = str(r[APPLIED_CHASE_STAGE_FIELD]) as AppliedChaseStage;

    // Terminal stages — this rail is done with them.
    if (stage === 'handed-off' || stage === 'stopped') {
      skip('terminal-stage');
      continue;
    }

    const hasActiveStage = stage !== '';
    // A row with an active stage that no longer qualifies gets a stop-flip;
    // a never-touched row that doesn't qualify is just skipped — no writes on
    // rows this rail never claimed (keeps the first sweep read-mostly).
    const leaveCohort = (reason: string): void => {
      if (hasActiveStage) stops.push({ id, ranchName, reason });
      skip(reason);
    };

    const onboarding = str(r['Onboarding Status']);
    const active = str(r['Active Status']);
    const verification = str(r['Verification Status']);

    if (r['Agreement Signed']) {
      leaveCohort('agreement-signed');
      continue;
    }
    if (onboarding && onboarding !== 'Docs Sent') {
      leaveCohort('onboarding-progressed');
      continue;
    }
    if (PARKED_ACTIVE.has(active) || verification === 'Removed') {
      leaveCohort('parked');
      continue;
    }
    if (verification === 'Verified') {
      leaveCohort('verified');
      continue;
    }
    // Self-submitted map prospects belong to rancher-onboarding-drip (its
    // welcome/day2/day5/day14 arc + rancher-followup's map-prospect copy).
    // Two rails chasing one inbox is the exact failure the shared stamp
    // exists to prevent — disjoint ownership beats throttled overlap.
    if (str(r['Self-Submitted At'])) {
      skip('self-submit-rail');
      continue;
    }
    // Already on the human dial list (another rail's day-14 terminal
    // escalation). The phone owns them now — no more automated email.
    if (str(r['Stuck Escalated At'])) {
      skip('already-escalated');
      continue;
    }

    const email = str(r['Email']).toLowerCase();
    if (email && isSyntheticTestEmail(email)) {
      skip('synthetic');
      continue;
    }

    const createdMs = Date.parse(str((r as { _createdTime?: unknown })._createdTime));
    if (!Number.isFinite(createdMs)) {
      // A row with no parseable created time is a degraded read — never
      // guess an age and email off it (rancher-followup's epoch-0 fallback
      // is how a fresh applicant can skip straight to terminal escalation).
      skip('bad-created-time');
      continue;
    }
    const ageDays = Math.floor((nowMs - createdMs) / DAY_MS);
    if (ageDays < 0) {
      skip('bad-created-time');
      continue;
    }

    const operatorName = str(r['Operator Name']);
    const state = str(r['State']);
    const bucket: AppliedChaseHandoffBucket =
      onboarding === 'Docs Sent' ? 'docs-sent' : 'new-applicant';

    // Dead email channel (none on file, or suppressed): the email lanes can
    // never land, so route to the human dial list once the row is old enough
    // that the welcome-email rescue rails have had their shot.
    const emailDead =
      !email || !!r['Unsubscribed'] || !!r['Bounced'] || !!r['Complained'];
    if (emailDead) {
      if (ageDays >= DAY2_MIN_AGE_DAYS) {
        eligible.push({
          id, ranchName, operatorName, email, state, ageDays,
          kind: 'handoff', nextStage: 'handed-off', priorStage: stage,
          bucket, emailDead: true, createdMs,
        });
      } else {
        skip('email-dead-too-fresh');
      }
      continue;
    }

    const due = whichTouchIsDue(stage, ageDays);
    if (due === null) {
      skip('not-due');
      continue;
    }
    if (due === 'handoff') {
      eligible.push({
        id, ranchName, operatorName, email, state, ageDays,
        kind: 'handoff', nextStage: 'handed-off', priorStage: stage,
        bucket, createdMs,
      });
      continue;
    }

    // Cross-rail quiet window — applies to SENDS only (a handoff writes
    // stamps, not email). Defer without advancing; the step retries later.
    const lastNudgeMs = Date.parse(str(r[LAST_ONBOARDING_NUDGE_FIELD]));
    if (Number.isFinite(lastNudgeMs) && nowMs - lastNudgeMs < CROSS_RAIL_QUIET_MS) {
      skip('cross-rail-quiet');
      continue;
    }

    eligible.push({
      id, ranchName, operatorName, email, state, ageDays,
      kind: 'send', touch: due, nextStage: NEXT_STAGE[due], priorStage: stage,
      createdMs,
    });
  }

  // Oldest application first — the longest-ignored casualty gets the first
  // slot under the cap; id tiebreak keeps the order stable between runs.
  eligible.sort((a, b) => a.createdMs - b.createdMs || a.id.localeCompare(b.id));
  const capped = eligible.slice(0, Math.max(0, maxTouches));
  if (eligible.length > capped.length) {
    skips['over-cap'] = eligible.length - capped.length;
  }

  return {
    actions: capped.map(({ createdMs: _createdMs, ...a }) => a),
    stops,
    skips,
  };
}
