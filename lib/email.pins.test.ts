import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Source pins for the guardedSend → logEmailSend attribution wiring
// (ADAPTIVE-MARKETING-DESIGN PR 1). lib/email.ts can't be imported here —
// module load pulls jwt/Resend/Airtable config — so these are grep pins,
// same pattern as the route pin files.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const emailSrc = readFileSync(path.join(HERE, 'email.ts'), 'utf8');
const guardSrc = readFileSync(path.join(HERE, 'emailFrequencyGuard.ts'), 'utf8');

test('PIN: guardedSend captures the Resend send id and logs it on the sent row', () => {
  // The suppression sentinel must never be persisted as a real message id.
  assert.match(emailSrc, /!isSuppressed && typeof result\?\.data\?\.id === 'string'/);
  assert.match(emailSrc, /resendId,/);
  // Success surface carries the id so callers can log it.
  assert.match(emailSrc, /return \{ success: true, id: resendId \};/);
});

test('PIN: variant rides to EVERY logEmailSend outcome inside guardedSend', () => {
  const matches = emailSrc.match(/variant: opts\.variant,/g) || [];
  // cap-suppressed, resolved-error failed, sent/suppressed, throw-failed.
  assert.ok(matches.length >= 4, `expected >=4 variant passthroughs, got ${matches.length}`);
});

test('PIN: sendEmail threads the attribution passthroughs to guardedSend', () => {
  assert.match(emailSrc, /recipientConsumerId: params\.recipientConsumerId,/);
  assert.match(emailSrc, /campaign: params\.campaign,/);
  assert.match(emailSrc, /variant: params\.variant,/);
});

test('PIN: logEmailSend writes Resend Id + Variant only when present (defensive)', () => {
  assert.match(guardSrc, /if \(input\.resendId\) \{\s*fields\['Resend Id'\] = input\.resendId;/);
  assert.match(guardSrc, /if \(input\.variant\) \{\s*fields\['Variant'\] = input\.variant;/);
});
