// app/api/cron/waiting-activation/route.pins.test.ts
//
// P0 SOURCE PINS — the waiting-activation rail's request-only belt + copy
// truth (2026-08-18).
//
// WHAT HAPPENED. This cron's supply gate called getServedStates(ranchers)
// with no request-only filter, and built `rancherSlugByState` from a second
// unfiltered pass over the same array. The one request-only ranch carries
// `Admin Approved Multi-State` + 48 Routing States, so:
//   • the SEND GATE saw 48 served states when 15 had real coverage — the
//     2026-08-18T16:23Z run emailed 50 buyers "ranchers in {state} have open
//     slots", a claim that was false for the 36 request-only-covered states;
//   • the READY-chase CTA resolved to the request-only rancher's page for
//     those same states — a generic promotion of supply Ben's standing rule
//     says is reachable ONLY by explicit buyer request.
//
// The belt itself lives in lib/routingSegment.getServedStates (unit-tested in
// lib/routingSegment.test.ts §4). These are grep pins: App Router route files
// export only HTTP handlers and pull the full Airtable/Resend stack at module
// load, so they can't be imported under tsx --test — same convention as
// app/api/cron/rancher-launch-warmup/route.pins.test.ts.
//
// The properties that must survive any refactor:
//   1. the slug map consults the ONE shared source of truth (no local copy),
//   2. the exclusion sits INSIDE the slug-map loop, before any state is
//      claimed for a slug,
//   3. exactly ONE Ranchers read, so both the gate and the map see the same
//      array,
//   4. neither template claims a rancher is IN the buyer's state — the
//      covering ranch may serve it from elsewhere (ships or multi-state
//      routes), so only "serving {state}" is true in both cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'route.ts'), 'utf8');
const emailSrc = readFileSync(path.join(HERE, '../../../../lib/email.ts'), 'utf8');

test('PIN: the route imports the shared request-only source of truth', () => {
  assert.match(src, /import \{ isRequestOnlyRancher \} from '@\/lib\/requestOnlyRanchers'/);
  // No second hardcoded copy of the policy in this route.
  assert.doesNotMatch(src, /'rep-provisions'/);
  assert.doesNotMatch(src, /recYE5zpedhPg6KIV/);
});

test('PIN: the READY-chase slug map rejects request-only ranchers', () => {
  const mapIdx = src.indexOf('for (const r of ranchers) {');
  assert.ok(mapIdx > -1, 'the slug-map loop must still exist');
  const exclusionIdx = src.indexOf('if (isRequestOnlyRancher(r)) continue;', mapIdx);
  assert.ok(exclusionIdx > -1, 'the slug-map loop must skip request-only ranchers');
  // The exclusion must precede the point where a slug claims a state.
  const claimIdx = src.indexOf('rancherSlugByState.set(', mapIdx);
  assert.ok(claimIdx > -1 && exclusionIdx < claimIdx, 'the skip must run BEFORE any state is claimed');
});

test('PIN: exactly ONE Ranchers read — gate and slug map share the filtered truth', () => {
  const reads = src.match(/getAllRecords\(TABLES\.RANCHERS\)/g) || [];
  assert.equal(
    reads.length,
    1,
    'a second Ranchers read would let the gate and the slug map disagree',
  );
});

test('PIN: the send gate is the shared helper, not a local loop', () => {
  assert.match(src, /import \{ getServedStates \} from '@\/lib\/routingSegment'/);
  assert.match(src, /supplyStates = getServedStates\(ranchers\)/);
});

// ── COPY TRUTH ─────────────────────────────────────────────────────────────
// Anti-pattern #2, docs/BHC.md: "Don't claim coverage we don't have." A
// rancher who covers a state via multi-state routing or nationwide shipping
// is NOT in that state. "serving {state}" is true either way.

test('COPY: the WAITING nudge never claims ranchers are IN the buyer state', () => {
  const start = emailSrc.indexOf('export async function sendWaitingActivationNudge');
  const end = emailSrc.indexOf('export async function sendReadyChaseNudge');
  assert.ok(start > -1 && end > start);
  const body = emailSrc.slice(start, end);
  assert.doesNotMatch(body, /ranchers in \$\{stateLabel\}/);
  assert.match(body, /ranchers serving \$\{stateLabel\}/);
});

test('COPY: the READY-chase subject and body claim "serving", never "in"', () => {
  const start = emailSrc.indexOf('export async function sendReadyChaseNudge');
  assert.ok(start > -1);
  const body = emailSrc.slice(start, start + 3000);
  assert.doesNotMatch(body, /A rancher in \$\{/);
  assert.match(body, /const subject = `a rancher serving \$\{/);
  assert.match(body, /rancher serving \$\{stateLabel\}/);
  // docs/BHC.md: subject lines are lowercase; every email signs "— Ben".
  assert.doesNotMatch(body, /<p style="font-size:12px;color:#A7A29A;">- Ben/);
});

test('COPY: the SMS bonus channel carries the same claim as the email', () => {
  const smsIdx = src.indexOf('Reply STOP to opt out.');
  assert.ok(smsIdx > -1, 'the SMS body must still exist');
  const line = src.slice(Math.max(0, smsIdx - 300), smsIdx);
  assert.doesNotMatch(line, /local ranchers/);
  assert.match(line, /ranchers serving your area/i);
});
