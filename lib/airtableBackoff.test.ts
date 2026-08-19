// Jittered, deadline-bounded rate-limit backoff (capacity audit 2026-08-19).
//
// WHAT BROKE (the shape these tests pin against): lib/airtable.ts's
// withRateLimitRetry slept 1→2→4→8→16→32s — up to 63 SECONDS inside a single
// request — with NO jitter and NO wall-clock deadline. Two consequences:
//   1. Every serverless instance that hit the same 429 slept the SAME amount
//      and therefore woke in LOCKSTEP, re-storming Airtable together. A
//      rate-limit burst became self-sustaining.
//   2. A request could hang for a minute. Airtable's penalty for exceeding
//      ~5 req/s is a 30s lockout of the WHOLE base, so the extra 33s of
//      sleeping bought nothing and burned the function's whole budget.
//
// These tests pin: delays are jittered inside documented bounds, two callers
// with different randomness never get the same schedule, and the loop gives up
// on a WALL-CLOCK deadline instead of an attempt count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planRetry,
  retryWithJitteredBackoff,
  resolveAirtableRetryDeadlineMs,
  DEFAULT_RETRY_DEADLINE_MS,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
} from './airtableBackoff';

// ── planRetry: the pure decision ─────────────────────────────────────────

test('delay is JITTERED — never the bare exponential, always inside [exp/2, exp)', () => {
  for (const attempt of [0, 1, 2, 3]) {
    const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
    for (const rand of [0, 0.25, 0.5, 0.99]) {
      const p = planRetry({ attempt, elapsedMs: 0, deadlineMs: 600_000, rand });
      assert.equal(p.retry, true, `attempt ${attempt} should retry with a huge deadline`);
      assert.ok(p.delayMs >= exp / 2, `delay ${p.delayMs} below floor ${exp / 2}`);
      assert.ok(p.delayMs < exp, `delay ${p.delayMs} at/above ceiling ${exp}`);
    }
  }
});

test('jitter actually varies — two instances with different randomness do NOT wake in lockstep', () => {
  const a = planRetry({ attempt: 3, elapsedMs: 0, deadlineMs: 600_000, rand: 0.05 });
  const b = planRetry({ attempt: 3, elapsedMs: 0, deadlineMs: 600_000, rand: 0.95 });
  assert.notEqual(a.delayMs, b.delayMs, 'identical delays = lockstep re-storm');
  assert.ok(Math.abs(a.delayMs - b.delayMs) > 100, 'jitter spread must be meaningful, not decorative');
});

test('delay is capped — exponential growth stops at MAX_DELAY_MS, never runs to 32s', () => {
  const p = planRetry({ attempt: 12, elapsedMs: 0, deadlineMs: 600_000, rand: 0.999 });
  assert.ok(p.delayMs < MAX_DELAY_MS, `delay ${p.delayMs} must stay under the ${MAX_DELAY_MS}ms cap`);
});

test('DEADLINE: refuses to retry once the wall-clock budget is already spent', () => {
  const p = planRetry({ attempt: 0, elapsedMs: 12_000, deadlineMs: 12_000, rand: 0.5 });
  assert.equal(p.retry, false);
  assert.equal(p.reason, 'deadline-exceeded');
});

test('DEADLINE: refuses to retry when the SLEEP would land past the deadline', () => {
  // 11.5s spent of a 12s budget; even the smallest jittered delay overruns.
  const p = planRetry({ attempt: 0, elapsedMs: 11_500, deadlineMs: 12_000, rand: 0 });
  assert.equal(p.retry, false, 'must not sleep past its own deadline');
  assert.equal(p.reason, 'deadline-exceeded');
});

test('DEADLINE is the binding constraint — the old 63s ladder is now impossible', () => {
  // Walk the worst case: every attempt returns instantly (pure rate-limit
  // rejection), max jitter every time. Total sleep must never approach 63s.
  let elapsed = 0;
  let attempt = 0;
  let totalSleep = 0;
  for (;;) {
    const p = planRetry({ attempt, elapsedMs: elapsed, deadlineMs: DEFAULT_RETRY_DEADLINE_MS, rand: 0.999 });
    if (!p.retry) break;
    totalSleep += p.delayMs;
    elapsed += p.delayMs;
    attempt += 1;
    assert.ok(attempt < 100, 'planRetry must terminate');
  }
  assert.ok(totalSleep <= DEFAULT_RETRY_DEADLINE_MS, `slept ${totalSleep}ms past the ${DEFAULT_RETRY_DEADLINE_MS}ms deadline`);
  assert.ok(totalSleep < 63_000, 'the 63-second hang must be structurally impossible');
});

test('attempt ceiling stops an infinite loop even with an unbounded deadline', () => {
  const p = planRetry({ attempt: 99, elapsedMs: 0, deadlineMs: Number.MAX_SAFE_INTEGER, rand: 0.5 });
  assert.equal(p.retry, false);
  assert.equal(p.reason, 'max-attempts');
});

test('resolveAirtableRetryDeadlineMs honors env, falls back on garbage', () => {
  const prev = process.env.AIRTABLE_RETRY_DEADLINE_MS;
  try {
    delete process.env.AIRTABLE_RETRY_DEADLINE_MS;
    assert.equal(resolveAirtableRetryDeadlineMs(), DEFAULT_RETRY_DEADLINE_MS);
    process.env.AIRTABLE_RETRY_DEADLINE_MS = '5000';
    assert.equal(resolveAirtableRetryDeadlineMs(), 5000);
    process.env.AIRTABLE_RETRY_DEADLINE_MS = 'banana';
    assert.equal(resolveAirtableRetryDeadlineMs(), DEFAULT_RETRY_DEADLINE_MS);
    process.env.AIRTABLE_RETRY_DEADLINE_MS = '-1';
    assert.equal(resolveAirtableRetryDeadlineMs(), DEFAULT_RETRY_DEADLINE_MS);
  } finally {
    if (prev === undefined) delete process.env.AIRTABLE_RETRY_DEADLINE_MS;
    else process.env.AIRTABLE_RETRY_DEADLINE_MS = prev;
  }
});

// ── retryWithJitteredBackoff: the loop ───────────────────────────────────
// Clock and sleep are injected so these run in microseconds, not minutes.

function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    slept,
  };
}

test('succeeds on the first try without sleeping', async () => {
  const clock = fakeClock();
  const out = await retryWithJitteredBackoff(async () => 'ok', {
    isRetryable: () => true,
    now: clock.now,
    sleep: clock.sleep,
    rand: () => 0.5,
  });
  assert.equal(out, 'ok');
  assert.deepEqual(clock.slept, []);
});

test('retries a retryable error then succeeds', async () => {
  const clock = fakeClock();
  let calls = 0;
  const out = await retryWithJitteredBackoff(
    async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('429 rate limit'), { statusCode: 429 });
      return 'recovered';
    },
    { isRetryable: (e: any) => e?.statusCode === 429, now: clock.now, sleep: clock.sleep, rand: () => 0.5 },
  );
  assert.equal(out, 'recovered');
  assert.equal(calls, 3);
  assert.equal(clock.slept.length, 2, 'one sleep per retry');
});

test('a NON-retryable error is thrown immediately, never slept on', async () => {
  const clock = fakeClock();
  await assert.rejects(
    retryWithJitteredBackoff(
      async () => {
        throw new Error('Unknown field name: "Bogus"');
      },
      { isRetryable: (e: any) => e?.statusCode === 429, now: clock.now, sleep: clock.sleep, rand: () => 0.5 },
    ),
    /Unknown field name/,
  );
  assert.deepEqual(clock.slept, [], 'a schema error must not be retried');
});

test('FAILS FAST at the deadline instead of hanging — and rethrows the ORIGINAL error', async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(
    retryWithJitteredBackoff(
      async () => {
        calls += 1;
        // Each attempt itself burns 2s of wall clock (a slow 429).
        clock.advance(2_000);
        throw Object.assign(new Error('429 rate limit'), { statusCode: 429 });
      },
      {
        isRetryable: (e: any) => e?.statusCode === 429,
        deadlineMs: 12_000,
        now: clock.now,
        sleep: clock.sleep,
        rand: () => 0.5,
      },
    ),
    // The caller's own classifiers key off the message — never swallow it.
    (err: any) => {
      assert.match(String(err?.message), /429 rate limit/);
      return true;
    },
  );
  assert.ok(clock.now() <= 12_000 + 4_000, `gave up at ${clock.now()}ms — must be near the 12s deadline, not 63s`);
  assert.ok(calls >= 2, 'must have retried at least once before giving up');
});

test('attempt time counts against the deadline — a slow attempt spends the retry budget', async () => {
  // The old loop only counted its own sleeps, so a request that had ALREADY
  // burned 12s on slow attempts would still queue up another 32s of sleeping.
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(
    retryWithJitteredBackoff(
      async () => {
        calls += 1;
        clock.advance(12_500); // one very slow attempt eats the whole budget
        throw Object.assign(new Error('429'), { statusCode: 429 });
      },
      { isRetryable: () => true, deadlineMs: 12_000, now: clock.now, sleep: clock.sleep, rand: () => 0.5 },
    ),
    /429/,
  );
  assert.equal(calls, 1, 'a single attempt that outran the deadline must not be retried at all');
  assert.deepEqual(clock.slept, [], 'must not sleep after the budget is gone');
});

test('slow attempts collapse the retry count (11s attempt against a 12s deadline ⇒ at most one more try)', async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(
    retryWithJitteredBackoff(
      async () => {
        calls += 1;
        clock.advance(11_000);
        throw Object.assign(new Error('429'), { statusCode: 429 });
      },
      { isRetryable: () => true, deadlineMs: 12_000, now: clock.now, sleep: clock.sleep, rand: () => 0.5 },
    ),
    /429/,
  );
  assert.equal(calls, 2, 'exactly one retry fit inside the remaining budget');
  assert.equal(clock.slept.length, 1);
});

test('sleeps are all distinct-able: the loop pulls fresh randomness per retry', async () => {
  const clock = fakeClock();
  const rands = [0.01, 0.99, 0.01, 0.99];
  let i = 0;
  await assert.rejects(
    retryWithJitteredBackoff(
      async () => {
        throw Object.assign(new Error('429'), { statusCode: 429 });
      },
      {
        isRetryable: () => true,
        deadlineMs: 60_000,
        now: clock.now,
        sleep: clock.sleep,
        rand: () => rands[i++ % rands.length],
      },
    ),
    /429/,
  );
  assert.ok(clock.slept.length >= 3, 'expected several retries inside a 60s deadline');
  assert.ok(new Set(clock.slept).size > 1, 'every sleep identical ⇒ randomness was not re-drawn');
});
