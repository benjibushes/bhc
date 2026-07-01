// Area C3: per-attempt timeout for Airtable SDK calls.
//
// The Airtable SDK does not accept an AbortSignal, so a hung TCP connection
// dangles until the serverless function's maxDuration kills it (60s of billed
// compute + a frozen user). Promise.race against a timer is the correct fix:
// the SDK request keeps running in the background (unavoidable — no abort),
// but the caller gets a prompt, typed THROW it can retry / 5xx on.
//
// CRITICAL SEMANTICS: a timeout is a transient FAILURE and must propagate as
// a throw. Never catch it and return empty data — an empty-array return would
// render "no ranchers" lies, the exact failure mode this repo has fought.
//
// Import-clean on purpose (no Airtable SDK, no env side effects at load) so
// it can be unit-tested hermetically: lib/airtableTimeout.test.ts.

const DEFAULT_AIRTABLE_TIMEOUT_MS = 10_000;

export class AirtableTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`Airtable operation timed out after ${ms}ms: ${label}`);
    this.name = 'AirtableTimeoutError';
  }
}

// Per-attempt budget. Env-tunable via AIRTABLE_TIMEOUT_MS; read at call time
// (not module load) so tests and runtime tweaks take effect immediately.
// Garbage / non-positive values fall back to the 10s default.
export function resolveAirtableTimeoutMs(): number {
  const raw = Number(process.env.AIRTABLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AIRTABLE_TIMEOUT_MS;
}

// Race `promise` against a timer. Resolves/rejects with the promise's own
// outcome when it settles first; rejects with AirtableTimeoutError (naming
// `label` — pass the table name) when the timer wins. The timer is cleared
// as soon as the promise settles so no open handle outlives the call.
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AirtableTimeoutError(label, ms)), ms);
    // Don't let the timeout timer itself pin a Node process open (serverless
    // runtimes reap on response; local scripts/tests shouldn't hang either).
    (timer as any).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
