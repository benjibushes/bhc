import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Source pins for the LIVE MATCHER's request-only exclusion (same grep-based
// pattern as the other route pins — App Router route files export only HTTP
// handlers and pull the full Airtable/Stripe/Resend stack at module load, so
// they can't be imported under tsx --test).
//
// WHAT THESE PROTECT (2026-08-17): Ben's standing rule that request-only
// specialty supply (Rep Provisions, grass-finished) is reachable ONLY by
// explicit buyer request. lib/campaignWaves had honored it since 2026-08-12;
// this route did NOT — its nationwide fallback pooled every rancher carrying
// `Admin Approved Multi-State` + `Ships Nationwide` (Rep has both) and then
// fitted them with nationwideFitVerdict, whose budget rule passes on BUDGET
// ALONE. An uncovered-state buyer with a big budget and zero grass-finished
// interest was one match away from the forbidden fallback, at ad volume.
//
// The three properties that must survive any refactor:
//   1. the exclusion runs in BOTH generic candidate sets (local + nationwide),
//   2. in the nationwide set it runs BEFORE nationwideFitVerdict, and
//   3. the DIRECT-PIN path never consults it — a pinned request-only rancher
//      still routes, which is the only way a buyer reaches them at all.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'route.ts'), 'utf8');

test('PIN: the route imports the shared request-only source of truth', () => {
  assert.match(src, /import \{ isRequestOnlyRancher \} from '@\/lib\/requestOnlyRanchers'/);
  // No second hardcoded copy of the policy in this route.
  assert.doesNotMatch(src, /'rep-provisions'/);
});

test('PIN: request-only ranchers are excluded from the NATIONWIDE fallback candidate set', () => {
  const nationwideFilterIdx = src.indexOf('const nationwideEligible = allRanchers.filter(');
  assert.ok(nationwideFilterIdx > -1, 'nationwide candidate filter must still exist');
  const exclusionIdx = src.indexOf('if (isRequestOnlyRancher(r)) {', nationwideFilterIdx);
  assert.ok(exclusionIdx > -1, 'nationwide filter must reject request-only ranchers');
  assert.match(src, /requestOnlySkips\.push\(/);
});

test('PIN: the nationwide exclusion runs BEFORE the buyer-fit gate (never fitted, never pooled)', () => {
  const nationwideFilterIdx = src.indexOf('const nationwideEligible = allRanchers.filter(');
  const exclusionIdx = src.indexOf('if (isRequestOnlyRancher(r)) {', nationwideFilterIdx);
  const fitIdx = src.indexOf('nationwideFitVerdict(fitBuyer, r)', nationwideFilterIdx);
  assert.ok(exclusionIdx > -1 && fitIdx > -1);
  assert.ok(
    exclusionIdx < fitIdx,
    'the request-only exclusion must precede nationwideFitVerdict — the fit gate passes on budget alone',
  );
  // ...and before the double-flag check that put them in the pool at all.
  const flagIdx = src.indexOf("r['Admin Approved Multi-State'] && r['Ships Nationwide']", nationwideFilterIdx);
  assert.ok(flagIdx > -1 && exclusionIdx < flagIdx);
});

test('PIN: request-only ranchers are excluded from the LOCAL / in-state candidate set too', () => {
  const localFilterIdx = src.indexOf('const localEligibleAll = allRanchers.filter(');
  assert.ok(localFilterIdx > -1, 'local candidate filter must still exist');
  const exclusionIdx = src.indexOf('if (isRequestOnlyRancher(r)) {', localFilterIdx);
  const baseIdx = src.indexOf('if (!isEligibleBase(r)) return false;', localFilterIdx);
  assert.ok(exclusionIdx > -1, 'local filter must reject request-only ranchers');
  assert.ok(exclusionIdx < baseIdx, 'exclusion is the first predicate, so the skip is logged');
  assert.match(src, /requestOnlyLocalSkips\.push\(/);
});

test('PIN: the shared base eligibility gate carries the backstop for any future pool', () => {
  const baseIdx = src.indexOf('const isEligibleBase = (r: any) => {');
  assert.ok(baseIdx > -1);
  const backstopIdx = src.indexOf('if (isRequestOnlyRancher(r)) return false;', baseIdx);
  const excludeIdsIdx = src.indexOf('if (excludeIds.has(r.id)) return false;', baseIdx);
  assert.ok(backstopIdx > -1, 'isEligibleBase must reject request-only ranchers');
  assert.ok(backstopIdx < excludeIdsIdx, 'backstop sits at the top of the base gate');
});

test('PIN: both skips are LOGGED in the route’s existing [match] style', () => {
  assert.match(src, /request-only rancher\(s\) excluded from the nationwide fallback/);
  assert.match(src, /request-only rancher\(s\) excluded from local matching/);
  assert.match(src, /reachable only by explicit buyer request — lib\/requestOnlyRanchers/);
});

test('PIN: the DIRECT-PIN path does NOT consult the request-only list (explicit request still routes)', () => {
  // The pin block spans from the campaign check to the direct-match assignment.
  const pinStart = src.indexOf('if (effectiveCampaign) {');
  const pinEnd = src.indexOf("matchType = 'direct';", pinStart);
  assert.ok(pinStart > -1 && pinEnd > pinStart, 'direct-pin block must still exist');
  const pinBlock = src.slice(pinStart, pinEnd);
  assert.doesNotMatch(
    pinBlock,
    /isRequestOnlyRancher/,
    'a buyer who pinned a request-only rancher must still be matched to them',
  );
  // The pin resolves by slug + the operational gate, exactly as before.
  assert.match(pinBlock, /const rancherSlug = effectiveCampaign\.replace\('rancher-', ''\)/);
  assert.match(pinBlock, /slug === rancherSlug && isRancherOperationalForBuyers\(r\)/);
  // And the pin short-circuits generic matching entirely.
  assert.match(src, /if \(directMatchRancher\) \{\n\s+\/\/ Lead came from this rancher's page/);
});

test('PIN: the pin block is resolved BEFORE any request-only exclusion runs', () => {
  const pinStart = src.indexOf('if (effectiveCampaign) {');
  const firstCandidateExclusion = src.indexOf('if (isRequestOnlyRancher(r)) {');
  assert.ok(pinStart > -1 && firstCandidateExclusion > -1);
  assert.ok(
    pinStart < firstCandidateExclusion,
    'pin resolution must precede the generic candidate filters',
  );
});
