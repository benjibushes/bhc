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

// ═════════════════════════════════════════════════════════════════════════════
// BROKER INVITE SEND-TRUTH (comms containment 2026-08-18, F6b).
//
// guardedSend resolves a frequency-cap/pause suppression AND a Resend API
// error as { success:false } WITHOUT throwing. The old broker branch set
// brokerInviteSent = true on any non-throw — so a suppressed invite was
// recorded as sent: 'Deposit Invite Sent At' got stamped, which (a) enrolled
// the row in the deposit-abandon chase (copy that presumes a delivered ask)
// and (b) suppressed the qualified-no-action rail for 24h via
// hasSameDayQuizInvite — longer than that rail's whole 30min–4h window. Net:
// the buyer's inbox stayed empty AND every automatic chase went quiet, on the
// one email whose deposit is 100% of BHC's fee.
// ═════════════════════════════════════════════════════════════════════════════

test('PIN: brokerInviteSent flips ONLY on a send result with success === true', () => {
  const inviteIdx = src.indexOf('await sendBrokerMatchInvite(');
  assert.ok(inviteIdx > -1, 'the broker invite send must still exist');
  // The result is captured and checked — not fire-and-forget.
  assert.match(src, /const inviteRes: any = await sendBrokerMatchInvite\(/);
  assert.match(src, /if \(inviteRes\?\.success === true\) \{\s*\n\s*brokerInviteSent = true;/);
  // No other site may flip the flag true.
  const flips = src.match(/brokerInviteSent = true/g) || [];
  assert.equal(flips.length, 1, 'exactly one site may record the invite as sent');
});

test('PIN: the Deposit Invite Sent At stamp is gated on the send actually succeeding', () => {
  const stampGateIdx = src.indexOf('if (brokerInviteSent) {');
  assert.ok(stampGateIdx > -1, 'the stamp gate must still exist');
  const stampIdx = src.indexOf("'Deposit Invite Sent At': new Date().toISOString()", stampGateIdx);
  const gateEnd = src.indexOf('// Operator handoff', stampGateIdx);
  assert.ok(
    stampIdx > stampGateIdx && (gateEnd === -1 || stampIdx < gateEnd),
    'the broker stamp write must sit inside if (brokerInviteSent)',
  );
});

test('PIN: an undelivered minted invite escalates LOUD with the real reason', () => {
  // The failure reason is captured on both non-throw and throw paths…
  assert.match(src, /brokerInviteFailReason = String\(inviteRes\?\.reason \|\| 'send-failed'\)/);
  assert.match(src, /brokerInviteFailReason = e\?\.message \|\| 'send-threw'/);
  // …and drives a loud operator signal, distinct from the no-sellable-cut card
  // (whose copy blames missing pricing — wrong for a send failure).
  const failSignalIdx = src.indexOf('BROKER INVITE NOT DELIVERED');
  assert.ok(failSignalIdx > -1, 'the undelivered-invite signal must exist');
  const failStart = src.indexOf('if (brokerInviteFailReason !== null)');
  assert.ok(failStart > -1, 'the undelivered branch must exist');
  const failEnd = src.indexOf('const card = buildBrokerMatchOperatorCard', failStart);
  assert.ok(failEnd > failStart, 'the card path must follow the undelivered branch');
  const failBlock = src.slice(failStart, failEnd);
  assert.match(failBlock, /urgency: 'loud'/);
  assert.match(failBlock, /kind: 'system-error'/);
  // The signal tells the operator the row was left UNSTAMPED on purpose —
  // the qualified-no-action chase (30min–4h) still fires for unstamped rows.
  assert.match(failBlock, /left unstamped/i);
});

test('PIN: the no-sellable-cut operator card path is preserved for genuinely uninvitable rows', () => {
  assert.match(src, /const card = buildBrokerMatchOperatorCard\(\{/);
  assert.match(src, /invited: brokerInviteSent/);
});

// ═════════════════════════════════════════════════════════════════════════════
// COMMISSION-RATE TRUTH in the rancher intro email (2026-08-18, F15 tail).
//
// The legacy-arm Closed-Won footer hardcoded "10% commission invoice" for
// every rancher the Connect-rail intro reaches (notifyPlan.rancherLeadEmail —
// broker rail never sends this email). A rancher with a locked Commission
// Rate (the mandated rate source since the Ashcraft 2026-05-20 dispute) or a
// non-10% tier was quoted a rate the charge path would contradict. Same class
// of bug as the #635 telegram footers — same fix: derive via
// commissionPercentLabelForRancher.
// ═════════════════════════════════════════════════════════════════════════════

test('PIN: the Closed-Won footer derives the commission rate from lib/tiers', () => {
  assert.match(src, /import \{ tierFor, commissionPercentLabelForRancher \} from '@\/lib\/tiers'/);
  assert.match(
    src,
    /auto-generates the \$\{commissionPercentLabelForRancher\(topMatch\)\} commission invoice/,
    'the footer must quote the rate the charge path would actually use',
  );
});

test('PIN: no hardcoded "10% commission" literal remains in the route', () => {
  assert.doesNotMatch(
    src,
    /10% commission/,
    'commission rates in rancher-facing copy must be derived, never a literal',
  );
});
