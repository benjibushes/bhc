// lib/staleNumbersGuard.test.ts
//
// Wave B "stats-truth" sweep (2026-08-17): source guards for stale
// buyer/backer-visible numbers that live outside the stats/tier modules.
//
//  • lib/email.ts claimed "buying a Quarter is $1,500–$2,000" while the live
//    network's quarters ranged $740–$2,200 (5 of 12 priced quarters at or
//    below $1,290) — the templates were talking buyers out of purchases they
//    could afford. Rule: buyer email templates assert NO dollar range for
//    shares. Quote weights; the rancher's page is the only price truth.
//
//  • The Telegram operator bot's system prompt was grounded in the dead
//    2026-Q1 model (flat 10% rancher-pays commission, 24-month term,
//    invitation-only, frozen "~245 consumers / ~26 ranchers / ~80 referrals"
//    pipeline). Rule: the prompt asserts no pipeline counts and none of the
//    dead-model claims — the bot has live data commands and must look counts
//    up. (The legacy-rail email footers deeper in the same file still say
//    "10% commission" — that is the real legacy-rancher rate and is NOT
//    covered by this guard.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('share-price ranges are gone from the buyer email templates', () => {
  const src = read('./email.ts');
  assert.doesNotMatch(src, /1,500\s*[–—-]\s*\$?2,000/);
  assert.doesNotMatch(src, /\$1,500/);
});

test('telegram operator prompt asserts neither the dead business model nor frozen pipeline counts', () => {
  const src = read('../app/api/webhooks/telegram/route.ts');
  assert.doesNotMatch(src, /24-month/);
  assert.doesNotMatch(src, /invitation-only/);
  assert.doesNotMatch(src, /~245|~26 ranchers|~80 referrals/);
  assert.doesNotMatch(src, /ranchers pay Ben 10% commission/);
  assert.doesNotMatch(src, /earns a 10% commission/);
  // The prompt must instruct the model to look pipeline numbers up live.
  assert.match(src, /NEVER assert counts from memory/i);
});
