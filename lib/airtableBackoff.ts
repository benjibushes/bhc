// lib/airtableBackoff.ts
//
// JITTERED, DEADLINE-BOUNDED RATE-LIMIT BACKOFF (capacity audit 2026-08-19).
//
// The bug this replaces: lib/airtable.ts's withRateLimitRetry slept
// 1s → 2s → 4s → 8s → 16s → 32s on a 429. Three defects, all load-bearing:
//
//   1. NO JITTER. Every serverless instance that caught the same 429 slept the
//      SAME number of milliseconds and therefore woke in LOCKSTEP and re-stormed
//      Airtable together. That is what turns a one-off burst into a
//      self-sustaining stall: Airtable's penalty for exceeding ~5 req/s is a
//      30-SECOND lockout of the entire base, and a synchronized fleet just
//      re-earns the lockout the instant it lifts.
//
//   2. NO WALL-CLOCK DEADLINE. 1+2+4+8+16+32 = 63 seconds of sleeping inside a
//      single request. The user's browser is gone long before that, the Vercel
//      function is billed the whole time, and the connection is held open —
//      which is itself back-pressure on the instance.
//
//   3. NO CEILING ON A SINGLE SLEEP. A 32-second sleep is never useful: the
//      lockout is 30s, and a request that has already waited 30s has failed
//      from the user's point of view regardless of what happens next.
//
// The fix: EQUAL JITTER (sleep ∈ [exp/2, exp) — never zero, so we don't hammer;
// never identical, so the fleet de-synchronizes), a per-sleep ceiling, and a
// WALL-CLOCK deadline measured from entry so a request fails FAST with the real
// underlying error instead of hanging.
//
// Deliberate trade-off, stated plainly: with a 12s deadline a request that
// lands inside a full 30s Airtable lockout now FAILS instead of eventually
// succeeding at ~35s. That is the correct outcome — a 35-second response is a
// failure the user already walked away from, and holding the connection open
// makes the storm worse for everyone behind it. Callers' existing catch/5xx
// paths are unchanged because the ORIGINAL error is rethrown.
//
// Import-clean on purpose (no Airtable SDK, no env read at module load) so it
// can be unit-tested hermetically with an injected clock: airtableBackoff.test.ts.

/** First retry sleeps ~[0.5s, 1s). */
export const BASE_DELAY_MS = 1_000;
/** No single sleep ever exceeds this — a longer one cannot help (see header). */
export const MAX_DELAY_MS = 4_000;
/** Total wall clock a single Airtable call may spend before giving up. */
export const DEFAULT_RETRY_DEADLINE_MS = 12_000;
/** Belt-and-suspenders loop guard; the deadline is the real constraint. */
export const MAX_RETRY_ATTEMPTS = 8;

export type RetryReason = 'retry' | 'deadline-exceeded' | 'max-attempts';

export interface RetryPlan {
  retry: boolean;
  delayMs: number;
  reason: RetryReason;
}

/**
 * Wall-clock retry budget for one Airtable operation. Env-tunable via
 * AIRTABLE_RETRY_DEADLINE_MS, read at CALL time (not module load) so an
 * incident can be tuned by an env change without a redeploy of behavior that
 * was baked in at import. Garbage / non-positive falls back to the default.
 */
export function resolveAirtableRetryDeadlineMs(): number {
  const raw = Number(process.env.AIRTABLE_RETRY_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETRY_DEADLINE_MS;
}

/**
 * Pure retry decision. `attempt` is the number of retries ALREADY made (0 on
 * the first failure). `elapsedMs` is wall clock since the operation started —
 * it includes the time the failed attempts themselves burned, not just sleeps,
 * so one slow attempt correctly shortens the remaining retry budget.
 *
 * Equal jitter: delay ∈ [exp/2, exp) where exp = min(base·2^attempt, cap).
 * Full jitter (∈ [0, exp)) was rejected because a near-zero sleep re-hits a
 * base that is still locked out, which is the exact hammering this exists to
 * stop.
 */
export function planRetry(opts: {
  attempt: number;
  elapsedMs: number;
  deadlineMs: number;
  rand: number; // [0, 1)
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}): RetryPlan {
  const {
    attempt,
    elapsedMs,
    deadlineMs,
    rand,
    baseDelayMs = BASE_DELAY_MS,
    maxDelayMs = MAX_DELAY_MS,
    maxAttempts = MAX_RETRY_ATTEMPTS,
  } = opts;

  if (attempt >= maxAttempts) return { retry: false, delayMs: 0, reason: 'max-attempts' };

  const exp = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  const half = exp / 2;
  // Clamp rand into [0, 1) so a caller passing 1 (or NaN) can't produce a
  // delay at/over the documented ceiling.
  const r = Number.isFinite(rand) ? Math.min(Math.max(rand, 0), 0.999999) : 0.5;
  const delayMs = Math.round(half + r * half);

  // Never sleep past our own deadline — that is the hang we are removing.
  if (elapsedMs >= deadlineMs || elapsedMs + delayMs >= deadlineMs) {
    return { retry: false, delayMs: 0, reason: 'deadline-exceeded' };
  }
  return { retry: true, delayMs, reason: 'retry' };
}

export interface RetryOptions {
  /** Only errors this classifies as retryable are slept on. Everything else throws immediately. */
  isRetryable: (error: unknown) => boolean;
  deadlineMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  /** Injected for tests; defaults to the real clock / timers / Math.random. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; elapsedMs: number }) => void;
  onGiveUp?: (info: { attempt: number; elapsedMs: number; reason: RetryReason }) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying retryable failures with jittered backoff until the
 * wall-clock deadline. On give-up the ORIGINAL error is rethrown untouched —
 * every existing caller classifier (unknown-field, bad-select-option,
 * AirtableTimeoutError) keeps working.
 */
export async function retryWithJitteredBackoff<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const rand = opts.rand ?? Math.random;
  const deadlineMs = opts.deadlineMs ?? resolveAirtableRetryDeadlineMs();
  const startedAt = now();

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (!opts.isRetryable(error)) throw error;
      const elapsedMs = now() - startedAt;
      const plan = planRetry({
        attempt,
        elapsedMs,
        deadlineMs,
        rand: rand(),
        baseDelayMs: opts.baseDelayMs,
        maxDelayMs: opts.maxDelayMs,
        maxAttempts: opts.maxAttempts,
      });
      if (!plan.retry) {
        opts.onGiveUp?.({ attempt, elapsedMs, reason: plan.reason });
        throw error;
      }
      opts.onRetry?.({ attempt, delayMs: plan.delayMs, elapsedMs });
      await sleep(plan.delayMs);
      attempt += 1;
    }
  }
}
