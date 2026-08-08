// lib/intentWindows.ts
//
// P5′ — TIERED INTENT WINDOWS (MARKETING-REVAMP-2026-08 §5, Track 1).
//
// The panel-amended pressure policy, encoded once, pure, and shared by every
// intent-chase rail:
//
//   intentKind        window   touches  schedule (days from intent)   decay
//   quiz              7 days   max 3    0 / 2 / 4  (~48h spacing)     +7d, ONE touch
//   deposit-invite    14 days  max 5    1 / 3 / 6 / 9 / 13 (ramping)  +7d, ONE touch
//
// WHY 14d for deposit-invite: median quiz→close is 2-21 days and ~90% of
// considered conversions land by day 12 — the old flat 2-touch/7-day chase
// closed before our own median buyer decides. WHY decay: after the window one
// final touch inside the following 7 days ("decay"), then permanent silence —
// pressure has a hard end date by construction.
//
// DIVISION OF LABOR (deliberate): this module only answers "is a touch due
// right now, and is the arc over". The CRONS keep everything else exactly as
// they had it — claim-before-send stamps ('Deposit Nudge Last Sent At' /
// 'Deposit Nudge Count' / 'Quiz Nudge Log'), per-run caps, suppression trio,
// verify-persist aborts. Touch counts always come from the existing stamps;
// the planner never invents state.
//
// FAIL-CLOSED RULES (every corrupt input means silence, never a storm):
//   - unparseable intentAt        → done + exhausted (no anchor, no sends)
//   - future intentAt             → silent, not exhausted (clock skew)
//   - touches>0 w/o lastTouchAt   → not due (spacing unverifiable)
//   - garbage touch count         → treated as 0 (stamps re-checked by crons)

export type IntentKind = 'quiz' | 'deposit-invite';

export type SprintTier = 'sprint' | 'decay' | 'done';

export interface SprintPlan {
  /** Send a touch right now (the caller still owns claims/caps/suppression). */
  due: boolean;
  /** No touch will EVER be due again for this intent — safe to stop looking. */
  exhausted: boolean;
  /** Which phase `now` falls in: in-window sprint, post-window decay week, done. */
  tier: SprintTier;
}

export interface IntentWindowPolicy {
  /** Sprint window length in days, counted from the intent moment. */
  windowDays: number;
  /** Max touches inside the sprint window. */
  maxTouches: number;
  /**
   * Day offsets from intentAt at which each touch becomes due; index =
   * touches already sent. Consecutive deltas double as the minimum spacing
   * versus the LAST touch, so a late touch never compresses the cadence.
   */
  touchOffsetsDays: readonly number[];
  /** Length of the post-window decay period (ONE final touch allowed). */
  decayDays: number;
}

export const INTENT_WINDOW_POLICIES: Readonly<Record<IntentKind, IntentWindowPolicy>> = {
  quiz: { windowDays: 7, maxTouches: 3, touchOffsetsDays: [0, 2, 4], decayDays: 7 },
  'deposit-invite': {
    windowDays: 14,
    maxTouches: 5,
    touchOffsetsDays: [1, 3, 6, 9, 13],
    decayDays: 7,
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Minimum gap between the last sprint touch and the one decay touch. */
const DECAY_MIN_GAP_MS = 48 * 60 * 60 * 1000;

function parseMs(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

/**
 * The planner. Decides {due, exhausted, tier} for one intent arc.
 *
 * @param intentKind   which policy row applies
 * @param intentAt     when the intent was expressed (ms | ISO string | Date)
 * @param touchesSoFar touches ALREADY sent — from the rail's existing stamps
 * @param now          current time in ms (injected for determinism)
 * @param opts.lastTouchAt when the last touch was sent — required for spacing
 *                     whenever touchesSoFar > 0 (fail-closed without it)
 */
export function sprintPlanFor(
  intentKind: IntentKind,
  intentAt: number | string | Date,
  touchesSoFar: number,
  now: number,
  opts?: { lastTouchAt?: number | string | Date | null },
): SprintPlan {
  const policy = INTENT_WINDOW_POLICIES[intentKind];
  const intentMs = parseMs(intentAt);
  if (intentMs === null) return { due: false, exhausted: true, tier: 'done' };

  // Future intent stamp = corrupt data or clock skew — silent, retry later.
  if (now < intentMs) return { due: false, exhausted: false, tier: 'sprint' };

  const touches =
    Number.isFinite(touchesSoFar) && touchesSoFar > 0 ? Math.floor(touchesSoFar) : 0;
  const lastTouchMs = parseMs(opts?.lastTouchAt ?? null);

  const windowEndMs = intentMs + policy.windowDays * DAY_MS;
  const decayEndMs = windowEndMs + policy.decayDays * DAY_MS;
  const tier: SprintTier = now <= windowEndMs ? 'sprint' : now <= decayEndMs ? 'decay' : 'done';

  // Lifetime bound: sprint budget + the one decay touch. Anything at/over is
  // over forever, whatever tier the clock says.
  if (touches >= policy.maxTouches + 1) return { due: false, exhausted: true, tier };

  if (tier === 'done') return { due: false, exhausted: true, tier };

  // Spacing needs the last-touch anchor; count>0 without it = data drift.
  const anchorMissing = touches > 0 && lastTouchMs === null;

  if (tier === 'decay') {
    // ONE final touch in the decay week — already fired if the last touch
    // landed after the window closed.
    if (lastTouchMs !== null && lastTouchMs >= windowEndMs) {
      return { due: false, exhausted: true, tier };
    }
    if (anchorMissing) return { due: false, exhausted: false, tier };
    if (lastTouchMs !== null && now - lastTouchMs < DECAY_MIN_GAP_MS) {
      return { due: false, exhausted: false, tier };
    }
    return { due: true, exhausted: false, tier };
  }

  // ── sprint ──
  if (touches >= policy.maxTouches) return { due: false, exhausted: false, tier };
  if (anchorMissing) return { due: false, exhausted: false, tier };

  const elapsedDays = (now - intentMs) / DAY_MS;
  if (elapsedDays < policy.touchOffsetsDays[touches]) {
    return { due: false, exhausted: false, tier };
  }
  if (touches > 0 && lastTouchMs !== null) {
    const minGapDays =
      policy.touchOffsetsDays[touches] - policy.touchOffsetsDays[touches - 1];
    if (now - lastTouchMs < minGapDays * DAY_MS) {
      return { due: false, exhausted: false, tier };
    }
  }
  return { due: true, exhausted: false, tier };
}
