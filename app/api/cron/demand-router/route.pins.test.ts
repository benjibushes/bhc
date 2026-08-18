import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Source pins for the demand-router cron's Wave-1 hardening (grep-based —
// App Router route files export only HTTP handlers and pull the full
// Airtable/Resend stack at module load, so they can't be imported under
// tsx --test; same convention as app/api/matching/suggest/route.pins.test.ts).
//
// WHAT THESE PROTECT (arming blockers, audit fce9126 → PR 2026-08-18):
//   F8  — the curated default pair is no longer nationwide-for-free: it
//         respects its own Routing States AND cedes any state owned by a
//         different operational state-table rancher (AZ→gila). ~110 AZ
//         waitlist buyers would otherwise get Montana deposit pushes the
//         hour this rail arms.
//   F19 — broker ranches never get a Connect-only /r/d token (redemption
//         resolves via getRancherBySlug, which excludes Broker Rail → the
//         link degrades to a bare page visit). BOTH link sites — resolveLink
//         (wave arc + SMS recovery) and recoveryLink (reserve recovery) —
//         must branch to the broker reserve surface.
//   F10 — a request-only rancher (Rep Provisions) configured into the pool
//         env is refused in resolveSlot, by slug AND by rec-id belt.
//   F24 — the suppression list is pre-warmed once per run and a build
//         failure aborts the LIVE batch loudly (never batch-send against an
//         empty suppression set during an Airtable outage).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'route.ts'), 'utf8');

// ── F10 — request-only guard in resolveSlot ────────────────────────────────

test('PIN F10: the route imports the shared request-only source of truth (slug set + rec-id belt)', () => {
  assert.match(src, /import \{ isRequestOnlyRancher, isRequestOnlyRancherId \} from '@\/lib\/requestOnlyRanchers'/);
  assert.doesNotMatch(src, /'rep-provisions'/);
});

test('PIN F10: resolveSlot refuses a request-only rancher — pool disabled, counted skip', () => {
  const slotIdx = src.indexOf('async function resolveSlot(');
  assert.ok(slotIdx > -1, 'resolveSlot must still exist');
  const guardIdx = src.indexOf('if (isRequestOnlyRancher(rec) || isRequestOnlyRancherId(id))', slotIdx);
  assert.ok(guardIdx > -1, 'resolveSlot must carry the request-only guard (slug AND rec-id)');
  // The guard must land BEFORE the pool is built (before the return of a live
  // target) — i.e. inside resolveSlot, before its final capacity return.
  const finalReturnIdx = src.indexOf('return { open: openSlotsFor(', slotIdx);
  assert.ok(finalReturnIdx > -1 && guardIdx < finalReturnIdx, 'guard must precede the live-pool return');
  // Operator-visible: the skip is pushed to the report list.
  const windowSrc = src.slice(guardIdx, guardIdx + 600);
  assert.match(windowSrc, /skipped\.push\(/);
});

// ── F8 — state-aware default pools ─────────────────────────────────────────

test('PIN F8: the curated default pair reach = own Routing States ∖ other-owned states (never servedStates null)', () => {
  assert.match(src, /import \{ rancherForStateTable \} from '@\/lib\/campaignWaves'/);
  assert.match(src, /defaultPairServedStates\(/, 'the pure F8 helper must be consumed');
  // The old hole: curated defaults shipped `servedStates: null` (nationwide)
  // from the healthy resolve path. The only null servedStates left must not
  // be attached to a live curated target.
  const slotIdx = src.indexOf('async function resolveSlot(');
  const healthy = src.slice(src.indexOf('const target = curatedTargetFor(id) ?? hydrateTarget(id, rec);', slotIdx));
  const healthyReturn = healthy.slice(0, healthy.indexOf('return { open: openSlotsFor(') + 200);
  assert.doesNotMatch(
    healthyReturn,
    /servedStates:\s*null/,
    'a healthy curated pool must never be nationwide-for-free again',
  );
});

test('PIN F8: transient default-pair fetch failure fails CLOSED (empty reach, not nationwide)', () => {
  const degradedIdx = src.indexOf('rancher record unavailable');
  assert.ok(degradedIdx > -1, 'the degraded branch must still exist');
  const windowSrc = src.slice(degradedIdx - 800, degradedIdx + 800);
  assert.doesNotMatch(windowSrc, /servedStates:\s*null/, 'degraded curated pool must not serve nationwide');
});

// ── F19 — broker reserve CTA at BOTH link sites ────────────────────────────

test('PIN F19: resolveLink branches broker ranches to the reserve surface BEFORE minting /r/d', () => {
  const fnIdx = src.indexOf('async function resolveLink(');
  assert.ok(fnIdx > -1, 'resolveLink must still exist');
  const fnSrc = src.slice(fnIdx, src.indexOf('async function readCapacity('));
  const brokerIdx = fnSrc.indexOf('brokerReservePageUrl(');
  const mintIdx = fnSrc.indexOf('mintCampaignReserveToken(');
  assert.ok(brokerIdx > -1, 'resolveLink must carry the broker branch');
  assert.ok(mintIdx > -1 && brokerIdx < mintIdx, 'broker branch must precede the Connect-only mint');
});

test('PIN F19: recoveryLink branches broker ranches to the reserve surface BEFORE minting /r/d', () => {
  const fnIdx = src.indexOf('function recoveryLink(');
  assert.ok(fnIdx > -1, 'recoveryLink must still exist');
  const fnSrc = src.slice(fnIdx, fnIdx + 1200);
  const brokerIdx = fnSrc.indexOf('brokerReservePageUrl(');
  const mintIdx = fnSrc.indexOf('mintCampaignReserveToken(');
  assert.ok(brokerIdx > -1, 'recoveryLink must carry the broker branch');
  assert.ok(mintIdx > -1 && brokerIdx < mintIdx, 'broker branch must precede the Connect-only mint');
});

test('PIN F19: broker-ness comes from the rancher RECORD (isBrokerRancher), not a guess', () => {
  assert.match(src, /import \{ isBrokerRancher \} from '@\/lib\/brokerRail'/);
  assert.match(src, /isBrokerRancher\(rec\)/);
});

// ── F24 — suppression pre-warm + loud abort ────────────────────────────────

test('PIN F24: the suppression list is pre-warmed once per run and a build failure aborts a LIVE batch loudly', () => {
  assert.match(src, /getSuppressionList\(\)/, 'pre-warm must exist');
  assert.match(src, /didSuppressionListBuildFail\(\)/, 'the fail-closed check must exist');
  const abortIdx = src.indexOf('didSuppressionListBuildFail()');
  const windowSrc = src.slice(abortIdx, abortIdx + 1200);
  assert.match(windowSrc, /status: 'error'/, 'a failed build must abort with an error status');
  assert.match(windowSrc, /sendTelegramMessage/, 'the abort must be loud (operator-visible)');
  // The abort happens BEFORE the send loop.
  const sendLoopIdx = src.indexOf('for (const send of plan.sends)');
  assert.ok(sendLoopIdx > -1 && abortIdx < sendLoopIdx, 'abort must precede the send loop');
});
