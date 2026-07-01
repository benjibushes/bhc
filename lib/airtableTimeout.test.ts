// Unit tests for the Airtable per-attempt timeout helper (Area C3).
// Without this helper, a hung Airtable TCP connection dangles until the
// serverless function's maxDuration (60s) kills it — these tests prove the
// race resolves/rejects promptly and cleans up its timer.
//
// Run: JWT_SECRET=test-secret-ci npx tsx --test lib/airtableTimeout.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withTimeout,
  AirtableTimeoutError,
  resolveAirtableTimeoutMs,
} from './airtableTimeout';

test('resolves before timeout: value passes through untouched', async () => {
  const result = await withTimeout(Promise.resolve(42), 1_000, 'Ranchers');
  assert.equal(result, 42);
});

test('rejects before timeout: underlying error passes through (not swallowed)', async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error('boom 429')), 1_000, 'Ranchers'),
    /boom 429/,
  );
});

test('exceeds timeout: rejects with AirtableTimeoutError naming the label', async () => {
  const never = new Promise<string>(() => {}); // simulates a hung TCP connection
  await assert.rejects(
    withTimeout(never, 20, 'Referrals'),
    (err: unknown) => {
      assert.ok(err instanceof AirtableTimeoutError, 'must be AirtableTimeoutError');
      assert.match((err as Error).message, /Referrals/, 'message must name the table');
      assert.match((err as Error).message, /20ms/, 'message must name the budget');
      assert.equal((err as Error).name, 'AirtableTimeoutError');
      return true;
    },
  );
});

test('timeout must THROW, never resolve to empty data', async () => {
  const never = new Promise<unknown[]>(() => {});
  let resolvedValue: unknown = 'did-not-resolve';
  try {
    resolvedValue = await withTimeout(never, 20, 'Ranchers');
  } catch (err) {
    assert.ok(err instanceof AirtableTimeoutError);
    return; // correct path
  }
  assert.fail(`withTimeout resolved (${JSON.stringify(resolvedValue)}) instead of throwing`);
});

test('timer is cleaned up on settle (no open handle keeps the process alive)', async () => {
  // A 60s timer left un-cleared would hold the event loop open for a minute;
  // node:test completing promptly IS the proof the timer was cleared.
  const v = await withTimeout(Promise.resolve('ok'), 60_000, 'Ranchers');
  assert.equal(v, 'ok');
  // Rejection path cleans up too.
  await assert.rejects(
    withTimeout(Promise.reject(new Error('nope')), 60_000, 'Ranchers'),
    /nope/,
  );
});

test('resolveAirtableTimeoutMs: default 10s, env-tunable, garbage-safe', () => {
  const prev = process.env.AIRTABLE_TIMEOUT_MS;
  try {
    delete process.env.AIRTABLE_TIMEOUT_MS;
    assert.equal(resolveAirtableTimeoutMs(), 10_000);
    process.env.AIRTABLE_TIMEOUT_MS = '2500';
    assert.equal(resolveAirtableTimeoutMs(), 2_500);
    process.env.AIRTABLE_TIMEOUT_MS = 'not-a-number';
    assert.equal(resolveAirtableTimeoutMs(), 10_000);
    process.env.AIRTABLE_TIMEOUT_MS = '0';
    assert.equal(resolveAirtableTimeoutMs(), 10_000);
    process.env.AIRTABLE_TIMEOUT_MS = '-5';
    assert.equal(resolveAirtableTimeoutMs(), 10_000);
  } finally {
    if (prev === undefined) delete process.env.AIRTABLE_TIMEOUT_MS;
    else process.env.AIRTABLE_TIMEOUT_MS = prev;
  }
});
