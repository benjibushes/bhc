// lib/suppressionFailClosed.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/suppressionFailClosed.test.ts
//
// F24 SLICE (Wave 1, 2026-08-18) — bulk senders FAIL CLOSED on a suppression-
// list outage.
//
// getSuppressionList() is deliberately fail-OPEN for transactional sends: on
// an Airtable outage it returns an EMPTY set (better to send a money email
// than drop it) and raises the didSuppressionListBuildFail() flag. The
// documented contract (lib/email.ts, scale audit 2026-07-22) is that BULK
// senders must check that flag and abort — send-scheduled honors it; the
// deposit-chase cron, the qualified-no-action cron, and the requalify-send
// campaign endpoint did not. During a suppression-list outage all three
// looped per-send checks against the empty set and mailed unsubscribed/
// bounced/complained addresses — CAN-SPAM exposure plus deliverability burn,
// on rails that are never urgent enough to send blind.
//
// Route/cron handlers cannot be imported under tsx --test (they pull the
// whole Airtable/Stripe/Resend stack at module load), so these are source
// pins — the lib/brokerDownstreamGates.test.ts convention. The pre-warm MUST
// sit before each file's send loop, and the abort must return without
// touching a single claim stamp.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PREWARM = 'await getSuppressionList();';
const CHECK = 'if (didSuppressionListBuildFail()) {';

test('CONTRACT REFERENCE: send-scheduled still honors the fail-closed flag (the pattern the others copy)', () => {
  const src = read('../app/api/cron/send-scheduled/route.ts');
  assert.ok(src.includes(PREWARM) && src.includes(CHECK));
});

test('FAIL CLOSED deposit-request-nudge: pre-warm once per run, abort the whole batch before any selection', () => {
  const src = read('../app/api/cron/deposit-request-nudge/route.ts');
  assert.match(src, /import \{ sendDemandRouterCampaign, getSuppressionList, didSuppressionListBuildFail \} from '@\/lib\/email';/);
  const warmIdx = src.indexOf(PREWARM);
  const checkIdx = src.indexOf(CHECK);
  assert.ok(warmIdx > -1 && checkIdx > warmIdx, 'pre-warm then flag check');
  // The abort must precede EVERY referral read and every rail (A/B/broker
  // lane/SMS rescue/rail C all send buyer email through the fail-open
  // wrapper) — aborting after selection would still be correct, but aborting
  // first is the simplest invariant: outage ⇒ zero I/O, zero stamps.
  const handlerIdx = src.indexOf('async function realHandler');
  assert.ok(warmIdx > handlerIdx, 'the pre-warm lives in the handler, not module scope');
  const firstRead = src.indexOf('getAllRecords(TABLES.REFERRALS, CANDIDATE_FORMULA)');
  assert.ok(checkIdx < firstRead, 'the abort must precede the candidate reads');
  // Loud, retryable, and honest about what happened.
  assert.match(src, /suppression-list build FAILED — deposit chase aborted \(fail closed\), will retry next tick/);
});

test('FAIL CLOSED qualified-no-action: pre-warm before the loop; the claim stamp can never precede the check', () => {
  const src = read('../app/api/cron/qualified-no-action/route.ts');
  assert.match(src, /import \{ sendEmail, getSuppressionList, didSuppressionListBuildFail \} from '@\/lib\/email';/);
  const warmIdx = src.indexOf(PREWARM);
  const checkIdx = src.indexOf(CHECK);
  assert.ok(warmIdx > -1 && checkIdx > warmIdx, 'pre-warm then flag check');
  const loopIdx = src.indexOf('for (const ref of candidateRefs) {');
  assert.ok(loopIdx > checkIdx, 'the abort must precede the send loop');
  // This cron claims (Consumer dedup stamp) before sending — an abort after
  // stamps would eat the buyer's one nudge with no email behind it.
  const claimIdx = src.indexOf('await updateRecord(TABLES.CONSUMERS, buyerId, {');
  assert.ok(claimIdx > checkIdx, 'no claim stamp may precede the fail-closed check');
  assert.match(src, /suppression-list build FAILED — nudge run aborted \(fail closed\), will retry next tick/);
});

test('FAIL CLOSED requalify-send: the batch refuses 503 before the loop; dryRun stays usable in an outage', () => {
  const src = read('../app/api/campaign/requalify-send/route.ts');
  assert.match(src, /import \{ sendEmail, getSuppressionList, didSuppressionListBuildFail \} from '@\/lib\/email';/);
  const warmIdx = src.indexOf(PREWARM);
  const checkIdx = src.indexOf(CHECK);
  assert.ok(warmIdx > -1 && checkIdx > warmIdx, 'pre-warm then flag check');
  // Same refusal shape as the budget check: 503, refuse-to-send-blind.
  assert.match(src, /\{ error: 'suppression-list build failed — refusing to send blind' \},\n\s*\{ status: 503 \},/);
  // Order: after the dryRun return (a dry run sends nothing and must keep
  // working during an outage), before the claim/send loop.
  const dryRunIdx = src.indexOf('if (dryRun) {');
  const loopIdx = src.indexOf('for (const p of planned) {');
  assert.ok(dryRunIdx > -1 && warmIdx > dryRunIdx, 'dryRun must not be blocked by the outage check');
  assert.ok(loopIdx > checkIdx, 'the refusal must precede the claim/send loop');
});
