// lib/singleFlight.ts
//
// IN-PROCESS REQUEST COALESCING (capacity audit 2026-08-19).
//
// The bug this closes: lib/airtable.ts's getAllRecords had no dedupe. A single
// warm lambda serving N concurrent /access visitors that all landed on the same
// cache-expiry boundary issued N SIMULTANEOUS full-table scans of Ranchers.
// A full scan is one Airtable request per 100 rows, so a handful of concurrent
// visitors is enough to blow through the ~5 req/s per-base ceiling — and the
// penalty for that is a 30-second lockout of the ENTIRE base, i.e. every buyer,
// every deposit, every webhook.
//
// Coalescing is the cheapest possible fix: while a fetch for key K is in
// flight, every other caller for K awaits the SAME promise instead of starting
// its own. N scans become 1.
//
// SCOPE, stated honestly: this is PER-INSTANCE. It collapses concurrency inside
// one lambda. Cross-instance fan-out is the job of the L2 Upstash cache in
// lib/sharedCache.ts (and of the longer L2 TTLs in lib/airtableCachePolicy.ts).
// The two together are what make the read path storm-resistant; neither alone is.
//
// CORRECTNESS: the entry is removed as soon as the promise SETTLES, so this is
// a coalescer, never a cache — a read that starts after the previous one
// finished always hits the source. A rejection propagates to every waiter and
// clears the key, so a failed fetch is never memoized as a permanent failure
// (and never silently degrades to empty data, which is the "no ranchers" lie
// this repo has fought repeatedly).

const _inflight = new Map<string, Promise<unknown>>();

/**
 * Share one in-flight `fn()` across all concurrent callers using the same
 * `key`. Later callers (after settle) get a fresh fetch.
 */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = _inflight.get(key);
  if (existing) return existing as Promise<T>;

  // A fetcher that throws SYNCHRONOUSLY must still be normalized to a rejected
  // promise, otherwise the finally-cleanup below never runs and the key leaks.
  let started: Promise<T>;
  try {
    started = fn();
  } catch (err) {
    return Promise.reject(err);
  }

  const shared = Promise.resolve(started).finally(() => {
    // Only clear if we still own the slot (defensive: a reset between start
    // and settle must not delete a newer entry).
    if (_inflight.get(key) === shared) _inflight.delete(key);
  });
  _inflight.set(key, shared);
  return shared;
}

/** Number of distinct keys currently in flight. Diagnostics + tests. */
export function inFlightCount(): number {
  return _inflight.size;
}

/** Drop all in-flight tracking. Tests only — never call this from app code. */
export function resetSingleFlight(): void {
  _inflight.clear();
}
