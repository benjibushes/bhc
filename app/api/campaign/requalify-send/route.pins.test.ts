import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Source pins for the requalify campaign sender (same grep-based pattern as
// the inbound-webhook pins — App Router route files export only HTTP handlers
// and pull the full Airtable/Resend stack at module load, so they can't be
// imported under tsx --test).
//
// WHAT THESE PROTECT (ADAPTIVE-MARKETING-DESIGN PR 1, 2026-08-10): the
// campaign rail's idempotency claim. Nothing ever wrote `Campaign Last Sent
// At` on this rail, so the "uncampaigned" pool filter passed vacuously
// forever and any re-run re-emailed the same cohort. The claim must stay
// BEFORE the send, revert on failure, and survive refactors silently.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'route.ts'), 'utf8');

test('PIN: claim stamps Campaign Last Sent At + Campaign Rail on Consumers', () => {
  assert.match(src, /'Campaign Last Sent At': nowIso/);
  // PR 2: the rail rides the VALIDATED body field (default 'requalify';
  // the campaign-autopilot cron passes 'autopilot') — never a free string.
  assert.match(src, /'Campaign Rail': rail/);
  assert.match(src, /const \{ recipients, campaign, dryRun, rancher, rail \} = parsed/);
  assert.match(src, /updateRecord\(TABLES\.CONSUMERS, row\.id/);
});

test('PIN: claim happens BEFORE the send (claim-before-send, not stamp-after)', () => {
  const claimIdx = src.indexOf(`'Campaign Last Sent At': nowIso`);
  const sendIdx = src.indexOf('const res = await sendEmail({');
  assert.ok(claimIdx > -1 && sendIdx > -1);
  assert.ok(claimIdx < sendIdx, 'claim stamp must precede sendEmail in the live loop');
});

test('PIN: render precedes the claim so a render failure consumes nothing', () => {
  const renderIdx = src.indexOf('rendered = renderRequalifyEmail(');
  const claimIdx = src.indexOf(`'Campaign Last Sent At': nowIso`);
  assert.ok(renderIdx > -1 && claimIdx > -1);
  assert.ok(renderIdx < claimIdx, 'render must precede the claim stamp');
  assert.match(src, /NOT stamped\/sent/);
});

test('PIN: a failed claim SKIPS the send (missed touch beats a double-send)', () => {
  assert.match(src, /claim stamp failed, send SKIPPED/);
  assert.match(src, /claim stamp failed — send skipped/);
});

test('PIN: failed sends revert the claim; terminal suppression keeps it', () => {
  assert.match(src, /revertClaims\('send failure'\)/);
  assert.match(src, /revertClaims\('send throw'\)/);
  // Cap/pause suppressions are transient — nothing delivered → revert.
  assert.match(src, /res\.reason !== 'unsubscribed-bounced-or-complained'/);
  assert.match(src, /revertClaims\('transient suppression'\)/);
});

test('PIN: revert restores the PRE-claim values, not blanks', () => {
  assert.match(src, /'Campaign Last Sent At': row\.prior\.lastSent/);
  assert.match(src, /'Campaign Rail': row\.prior\.rail/);
});

test('PIN: variant kill switch is honored and the SENT arm rides to Email Sends', () => {
  assert.match(src, /variantMode\(\)/);
  // Only 'live' sends the assigned arm; shadow/off send A.
  assert.match(src, /vmode === 'live'/);
  assert.match(src, /variant: p\.variantSent \|\| undefined/);
});

test('PIN: Email Sends attribution passthroughs on the campaign send', () => {
  assert.match(src, /recipientConsumerId: p\.replyConsumerId \|\| undefined/);
  assert.match(src, /campaign,\n/);
});

test('PIN: reply threading untouched (usr context still passed)', () => {
  assert.match(src, /_replyContext: \{ type: 'usr', recordId: p\.replyConsumerId \}/);
});
