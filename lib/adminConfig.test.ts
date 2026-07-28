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
import {
  getAdminConfig,
  getAdminConfigWithSource,
  saveAdminConfig,
  ADMIN_CONFIG_DEFAULTS,
} from './adminConfig';
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

// ── THE FALSE SUCCESS (pause-asymmetry sweep 2026-07-25) ───────────────────
// saveAdminConfig used to swallow its own write failure and return a
// success-shaped config, so /admin/settings rendered "Config saved" over a
// write that never happened. The read path made it worse: defaults and real
// overrides were byte-identical, so nobody could tell the Admin Config table
// was empty (it has ZERO rows in production). Both now tell the truth.

test('saveAdminConfig THROWS when nothing was persisted — never a silent success', { skip: airtableConfigured }, async () => {
  // No Airtable base → nothing can persist. The old contract resolved with a
  // defaults-shaped object, which the UI rendered as "saved".
  await assert.rejects(
    () => saveAdminConfig({ stallThresholdDays: 99 }),
    (err: Error) => {
      assert.match(err.message, /NOT saved/i);
      return true;
    },
  );
});

test('a failed save does not silently mutate the live config', { skip: airtableConfigured }, async () => {
  await saveAdminConfig({ stallThresholdDays: 99 }).catch(() => {});
  const after = await getAdminConfig();
  assert.deepEqual(after, ADMIN_CONFIG_DEFAULTS);
  assert.notEqual(after.stallThresholdDays, 99);
});

test('read path says WHERE the config came from — defaults are distinguishable', { skip: airtableConfigured }, async () => {
  const { config, source } = await getAdminConfigWithSource();
  assert.deepEqual(config, ADMIN_CONFIG_DEFAULTS);
  // Never 'airtable' when nothing was read — that is the whole point.
  assert.notEqual(source, 'airtable');
  assert.ok(source.startsWith('defaults:'), `unexpected source: ${source}`);
});

test('getAdminConfig stays a plain config — callers are not broken by the new shape', { skip: airtableConfigured }, async () => {
  const cfg = await getAdminConfig();
  assert.deepEqual(cfg, ADMIN_CONFIG_DEFAULTS);
  assert.equal((cfg as any).source, undefined);
  assert.equal((cfg as any).config, undefined);
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
