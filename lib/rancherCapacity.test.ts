import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimSyncLock,
  releaseClaim,
  claimOnce,
  getMaxActiveReferrals,
  hasExplicitMaxActiveReferrals,
  MAX_ACTIVE_REFERRALS_FIELD,
} from './rancherCapacity';

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

// ── hasExplicitMaxActiveReferrals — the fake-scarcity guard (2026-08-18) ─────
// getMaxActiveReferrals DEFAULTS to 5 when the field is blank. That default is
// correct for ROUTING (fail-closed on a sane cap) and catastrophic for DISPLAY:
// the public rancher page multiplied it into "● 3 shares left this round" for
// Gila River Cattle — a scarcity number nobody configured, invented by a code
// default, live to buyers. Display surfaces must ask THIS question instead.

test('hasExplicitMaxActiveReferrals is TRUE only when the cap is really on the record', () => {
  // Champion Valley / Foodstead / Renick — cap explicitly set to 50.
  assert.equal(hasExplicitMaxActiveReferrals({ 'Max Active Referalls': 50 }), true);
  // Rafter S7 — a small explicit cap.
  assert.equal(hasExplicitMaxActiveReferrals({ 'Max Active Referalls': 3 }), true);
  // Reads the corrected spelling too, exactly like getMaxActiveReferrals.
  assert.equal(hasExplicitMaxActiveReferrals({ 'Max Active Referrals': 20 }), true);
  // An explicit 0 is still explicit (the rancher IS configured, at zero).
  assert.equal(hasExplicitMaxActiveReferrals({ 'Max Active Referalls': 0 }), true);
});

test('hasExplicitMaxActiveReferrals is FALSE for a blank cap (Gila River Cattle)', () => {
  assert.equal(hasExplicitMaxActiveReferrals({ 'Current Active Referrals': 2 }), false);
  assert.equal(hasExplicitMaxActiveReferrals({ 'Max Active Referalls': '' }), false);
  assert.equal(hasExplicitMaxActiveReferrals({ 'Max Active Referalls': null }), false);
  assert.equal(hasExplicitMaxActiveReferrals({ 'Max Active Referalls': undefined }), false);
  assert.equal(hasExplicitMaxActiveReferrals({}), false);
  assert.equal(hasExplicitMaxActiveReferrals(null), false);
});

test('hasExplicitMaxActiveReferrals covers the exact field name writes use', () => {
  // Both spellings stay wired together — the 2026-06-30 landmine.
  assert.equal(hasExplicitMaxActiveReferrals({ [MAX_ACTIVE_REFERRALS_FIELD]: 12 }), true);
  assert.equal(getMaxActiveReferrals({ [MAX_ACTIVE_REFERRALS_FIELD]: 12 }), 12);
  // ...and the routing default is deliberately UNCHANGED by this addition.
  assert.equal(getMaxActiveReferrals({}), 5);
});
