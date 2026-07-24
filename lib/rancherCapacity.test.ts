import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimSyncLock, releaseClaim, claimOnce } from './rancherCapacity';

// The test env sets no UPSTASH_REDIS_* vars, so getRedis() returns null and
// every Redis-backed helper hits its no-Redis branch. That's exactly the
// local-dev / single-instance case we need to pin down.

test('M3: claimSyncLock degrades OPEN when Redis is absent (dev/single-instance, no race)', async () => {
  // No Redis env → no cron/webhook race to guard → the sync MUST still run,
  // otherwise the feature is dead on any Redis-less deployment.
  assert.equal(await claimSyncLock('shopify-sync-recTEST', 300), true);
});

test('M3: releaseClaim is a safe no-op when Redis is absent (never throws)', async () => {
  await assert.doesNotReject(() => releaseClaim('shopify-sync-recTEST'));
});

test('M3: claimOnce (the money-webhook lock) still degrades OPEN — unchanged', async () => {
  // Guard against accidentally changing the shared claimOnce contract while
  // adding the sync-specific variant: deposits must never be blocked.
  assert.equal(await claimOnce('some-deposit-key', 60), true);
});
