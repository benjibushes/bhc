import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Source pins for the Resend engagement webhook (grep-based, same reason as
// the other route pins: App Router route files can't be imported under
// tsx --test).
//
// WHAT THESE PROTECT (ADAPTIVE-MARKETING-DESIGN PR 1, 2026-08-10):
// message-id attribution. Events carry data.email_id — the id guardedSend
// persists to Email Sends `Resend Id` at send time — and the webhook must
// stamp THAT row. The latest-row-within-7d heuristic (which let any
// intervening send steal the delivered/open/click stamp) survives ONLY as a
// fallback for rows sent before the field existed.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, 'route.ts'), 'utf8');

test('PIN: engagement events match the Email Sends row by Resend Id FIRST', () => {
  assert.match(src, /const resendId = String\(data\.email_id \|\| ''\)\.trim\(\);/);
  assert.match(src, /\{Resend Id\} = "\$\{escapeAirtableValue\(resendId\)\}"/);
});

test('PIN: id lookup is fail-soft — a missing field falls back to the heuristic', () => {
  assert.match(
    src,
    /Resend Id lookup failed \(falling back to latest-row heuristic\)/,
    'the id query must be try/caught (the field may not exist yet)',
  );
});

test('PIN: latest-row-within-7d heuristic survives as the fallback only', () => {
  const idIdx = src.indexOf('{Resend Id} = ');
  const fallbackIdx = src.indexOf('IS_AFTER({Sent At}, "${cutoff}")');
  assert.ok(idIdx > -1 && fallbackIdx > -1);
  assert.ok(idIdx < fallbackIdx, 'id match must be attempted before the 7d heuristic');
  assert.match(src, /if \(!target\) \{/);
});

test('PIN: first-touch stamps preserved (Opened At/Clicked At never overwritten)', () => {
  assert.match(src, /updates\['Opened At'\] = target\['Opened At'\] \|\| now;/);
  assert.match(src, /updates\['Clicked At'\] = target\['Clicked At'\] \|\| now;/);
});

test('PIN: consumer-level engagement stamps untouched by the attribution change', () => {
  assert.match(src, /updates\['Last Email Clicked At'\] = now;/);
  assert.match(src, /Number\(c\['Email Clicks'\] \|\| 0\) \+ 1/);
});
