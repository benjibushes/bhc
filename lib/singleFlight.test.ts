// In-process request coalescing (capacity audit 2026-08-19).
//
// WHAT BROKE: getAllRecords had no dedupe. A warm lambda serving N concurrent
// /access visitors that all landed on the same cache-expiry boundary issued N
// simultaneous full-table scans of Ranchers. Each scan is ~1 request per 100
// rows, so a handful of concurrent visitors could blow straight through
// Airtable's ~5 req/s per-base ceiling — which costs a 30-second lockout of
// the ENTIRE base. Coalescing collapses those N scans into ONE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { singleFlight, inFlightCount, resetSingleFlight } from './singleFlight';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('N concurrent identical reads collapse to ONE underlying fetch', async () => {
  resetSingleFlight();
  let fetches = 0;
  const gate = deferred<string[]>();
  const fetcher = () => {
    fetches += 1;
    return gate.promise;
  };

  // 25 concurrent visitors — the top of the estimated trigger range.
  const inflight = Array.from({ length: 25 }, () => singleFlight('Ranchers::full', fetcher));
  assert.equal(fetches, 1, `25 concurrent callers issued ${fetches} fetches — must be exactly 1`);
  assert.equal(inFlightCount(), 1);

  gate.resolve(['a', 'b']);
  const results = await Promise.all(inflight);
  assert.equal(results.length, 25);
  for (const r of results) assert.deepEqual(r, ['a', 'b'], 'every waiter gets the shared result');
  assert.equal(fetches, 1);
});

test('the in-flight entry is released on settle — a LATER read re-fetches (never a permanent cache)', async () => {
  resetSingleFlight();
  let fetches = 0;
  const fetcher = async () => {
    fetches += 1;
    return fetches;
  };
  assert.equal(await singleFlight('k', fetcher), 1);
  assert.equal(inFlightCount(), 0, 'entry must be dropped once settled');
  assert.equal(await singleFlight('k', fetcher), 2, 'a sequential read must hit the source again');
  assert.equal(fetches, 2);
});

test('different keys do NOT share a fetch (Ranchers must never serve a Rancher Products read)', async () => {
  resetSingleFlight();
  const calls: string[] = [];
  const make = (name: string) => async () => {
    calls.push(name);
    return name;
  };
  const [a, b] = await Promise.all([
    singleFlight('Ranchers::full', make('ranchers')),
    singleFlight('Rancher Products::full', make('products')),
  ]);
  assert.equal(a, 'ranchers');
  assert.equal(b, 'products');
  assert.equal(calls.length, 2, 'distinct keys must not be coalesced');
});

test('rejection propagates to EVERY waiter and does not poison the key', async () => {
  resetSingleFlight();
  let fetches = 0;
  const gate = deferred<string>();
  const failing = () => {
    fetches += 1;
    return gate.promise;
  };
  const waiters = [singleFlight('k', failing), singleFlight('k', failing), singleFlight('k', failing)];
  assert.equal(fetches, 1);
  gate.reject(new Error('429 rate limit'));

  const settled = await Promise.allSettled(waiters);
  assert.equal(settled.length, 3);
  for (const s of settled) {
    assert.equal(s.status, 'rejected', 'a failed shared fetch must fail every waiter — never silently resolve empty');
    assert.match(String((s as PromiseRejectedResult).reason?.message), /429 rate limit/);
  }
  assert.equal(inFlightCount(), 0, 'a rejected entry must be cleared, not cached as a permanent failure');

  // The very next caller gets a fresh attempt.
  assert.equal(await singleFlight('k', async () => 'ok-now'), 'ok-now');
});

test('a waiter that joins mid-flight still gets the shared result', async () => {
  resetSingleFlight();
  let fetches = 0;
  const gate = deferred<number>();
  const fetcher = () => {
    fetches += 1;
    return gate.promise;
  };
  const first = singleFlight('k', fetcher);
  await Promise.resolve(); // yield a microtask — a real second request arriving later
  const second = singleFlight('k', fetcher);
  gate.resolve(7);
  assert.deepEqual(await Promise.all([first, second]), [7, 7]);
  assert.equal(fetches, 1);
});

test('a THROWING (not rejecting) fetcher is still coalesced and still clears', async () => {
  resetSingleFlight();
  await assert.rejects(
    singleFlight('k', () => {
      throw new Error('sync boom');
    }),
    /sync boom/,
  );
  assert.equal(inFlightCount(), 0);
});
