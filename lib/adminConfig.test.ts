// adminConfig cache wiring — fail-open / env-unset contract.
//
// The whole suite runs with NO Upstash env AND (in CI) no Airtable env, so
// these tests pin the production degrade path: the L2 Redis layer must be a
// transparent no-op when unconfigured, and the read/save path must NEVER throw
// — it degrades to the baked-in defaults exactly as it did before the shared
// cache existed. This is the "Redis-down / env-unset behaves identically to
// today" guardrail, proven at the caller boundary (not just the primitive).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdminConfig, saveAdminConfig, ADMIN_CONFIG_DEFAULTS } from './adminConfig';
import { serialize, deserialize } from './sharedCache';
import type { AdminConfig } from './adminConfigTypes';

// Guard: these assertions only hold when Airtable is NOT configured (CI/test).
// If someone runs the suite with live AIRTABLE_* env, skip rather than assert
// against real data.
const airtableConfigured = !!(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID);

test('getAdminConfig with no Airtable + no Redis → defaults, never throws', { skip: airtableConfigured }, async () => {
  const cfg = await getAdminConfig();
  assert.deepEqual(cfg, ADMIN_CONFIG_DEFAULTS);
});

test('getAdminConfig is stable across repeated calls (L1/L2 no-op path)', { skip: airtableConfigured }, async () => {
  const a = await getAdminConfig();
  const b = await getAdminConfig();
  assert.deepEqual(a, b);
  assert.deepEqual(b, ADMIN_CONFIG_DEFAULTS);
});

test('saveAdminConfig with no Airtable → invalidates + returns defaults, never throws', { skip: airtableConfigured }, async () => {
  // No base → nothing persists, but the call must resolve to defaults and not
  // throw (the shared-cache delete inside is fail-safe).
  await assert.doesNotReject(async () => {
    const out = await saveAdminConfig({ stallThresholdDays: 99 });
    assert.deepEqual(out, ADMIN_CONFIG_DEFAULTS); // not persisted (no base)
  });
});

// The L2 layer stores/loads the resolved AdminConfig via serialize/deserialize.
// Pin that an AdminConfig survives the round-trip byte-for-byte, and that the
// defaults-merge tolerates a shared value missing a newly-added key (forward
// compat: an older instance's cached shape must never drop a field).
test('AdminConfig round-trips through the shared-cache serializer exactly', () => {
  const cfg: AdminConfig = {
    stallThresholdDays: 7,
    highIntentCutoff: 65,
    migrationDeadlineDays: 10,
    capacityWarningPct: 90,
    funnelOfferOperatorCall: true,
  };
  assert.deepEqual(deserialize<AdminConfig>(serialize(cfg)), cfg);
});

test('defaults-merge fills a key missing from an older shared cache shape', () => {
  // Simulate a shared value written by an older deploy lacking one key.
  const partial = { stallThresholdDays: 3 };
  const merged = { ...ADMIN_CONFIG_DEFAULTS, ...deserialize<Partial<AdminConfig>>(serialize(partial)) };
  assert.equal(merged.stallThresholdDays, 3); // override wins
  assert.equal(merged.funnelOfferOperatorCall, ADMIN_CONFIG_DEFAULTS.funnelOfferOperatorCall); // default fills
});
