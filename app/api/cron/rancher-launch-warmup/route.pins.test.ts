import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { isRequestOnlyRancher } from '../../../../lib/requestOnlyRanchers';

// Source pins for the launch-warmup cron's request-only exclusion (grep-based —
// App Router route files export only HTTP handlers and pull the full
// Airtable/Resend stack at module load, so they can't be imported under
// tsx --test; same convention as app/api/matching/suggest/route.pins.test.ts).
//
// WHAT THESE PROTECT (comms containment 2026-08-18, F3): Ben's standing rule
// that request-only specialty supply (Rep Provisions, grass-finished) is
// NEVER campaigned or promoted. The rule was already honored by the live
// matcher (2026-08-17) and the campaign-wave table (2026-08-12) — but THIS
// cron's daily pool filtered on isRancherOperationalForBuyers alone, and a
// routable self-serve broker ranch passes that gate. Result: the warmup
// engine was mass-emailing waitlisted buyers "Rep Provisions is now live in
// your state" every day — a first-touch campaign send, the exact violation
// that already happened once in prod.
//
// The properties that must survive any refactor:
//   1. the pool consults the ONE shared source of truth (lib/requestOnlyRanchers),
//   2. the exclusion is a COUNTED skip (skipReasonBreakdown shows it),
//   3. every pool selection in the file inherits it — there is exactly one
//      Ranchers read, and the Phase-2 nudge's personalization lookup rides
//      the same filtered array (a nudge NAMING the ranch is promotion too).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'route.ts'), 'utf8');

test('PIN: the route imports the shared request-only source of truth', () => {
  assert.match(src, /import \{ isRequestOnlyRancher \} from '@\/lib\/requestOnlyRanchers'/);
  // No second hardcoded copy of the policy in this route.
  assert.doesNotMatch(src, /'rep-provisions'/);
});

test('PIN: the daily pool filter rejects request-only ranchers with a COUNTED skip', () => {
  const poolFilterIdx = src.indexOf('const ranchers = allRanchers.filter(');
  assert.ok(poolFilterIdx > -1, 'the pool filter must still exist');
  const exclusionIdx = src.indexOf('if (isRequestOnlyRancher(r)) {', poolFilterIdx);
  assert.ok(exclusionIdx > -1, 'the pool filter must reject request-only ranchers');
  // Counted skip — visible in the cron run's skipReasonBreakdown.
  assert.match(src, /skipReasons\['request-only-rancher'\]/);
  // The exclusion lives INSIDE the pool filter (before the filter's closing
  // `return true`), not in some later per-branch check a refactor could drop.
  const filterEndIdx = src.indexOf('return true;', poolFilterIdx);
  assert.ok(filterEndIdx > -1 && exclusionIdx < filterEndIdx);
});

test('PIN: exactly ONE Ranchers read — every pool selection inherits the filter', () => {
  const reads = src.match(/getAllRecords\(TABLES\.RANCHERS\)/g) || [];
  assert.equal(
    reads.length,
    1,
    'a second Ranchers read would bypass the request-only filter — route new pools through the filtered array',
  );
});

test('PIN: the Phase-2 nudge personalization rides the FILTERED pool, never allRanchers', () => {
  const phase2Idx = src.indexOf('PHASE 2');
  assert.ok(phase2Idx > -1, 'Phase 2 must still exist');
  const phase2 = src.slice(phase2Idx);
  // The activeRancher lookup that puts a ranch NAME in the nudge email must
  // consult the filtered `ranchers` array (request-only already excluded).
  assert.match(phase2, /const activeRancher = ranchers\.find\(/);
  assert.doesNotMatch(
    phase2,
    /allRanchers\.find\(/,
    'naming a request-only ranch in a nudge is promotion — the lookup must use the filtered pool',
  );
});

// ── Both directions of the predicate the pool now consults ──────────────────
// The pins above prove the route calls isRequestOnlyRancher; these prove that
// predicate excludes exactly the request-only ranch and nobody else — so a
// normal operational rancher still warms their state's waitlist.

test('DIRECTION: Rep Provisions (any slug casing) is request-only — excluded from the pool', () => {
  assert.equal(isRequestOnlyRancher({ Slug: 'rep-provisions' }), true);
  assert.equal(isRequestOnlyRancher({ Slug: 'Rep-Provisions' }), true);
});

test('DIRECTION: a normal rancher is NOT request-only — still warms', () => {
  assert.equal(isRequestOnlyRancher({ Slug: 'champion-valley' }), false);
  assert.equal(isRequestOnlyRancher({ Slug: '' }), false);
  assert.equal(isRequestOnlyRancher({}), false);
});
