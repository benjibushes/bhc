// lib/foundersTiers.test.ts
//
// Wave B "stats-truth" sweep (2026-08-17): the IG DM closer
// (app/api/webhooks/manychat/route.ts) quoted Founding 100 at a hardcoded
// $1,000 and Title Founder at "$5k+" while the live /founders page derived
// $1,500 post-early-bird and rendered $15,000 / 10 spots. Tier pricing now
// lives in ONE module (lib/foundersTiers) consumed by BOTH the /founders page
// and the manychat webhook prompt, so the DM bot can never quote a price the
// page (and checkout) would contradict. Mutation rule: re-introducing any
// hardcoded tier-price literal in either consumer fails these tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  HERD_MONTHLY_DOLLARS,
  HERD_ANNUAL_DOLLARS,
  OUTLAW_MONTHLY_DOLLARS,
  OUTLAW_ANNUAL_DOLLARS,
  STEWARD_MONTHLY_DOLLARS,
  STEWARD_ANNUAL_DOLLARS,
  TITLE_FOUNDER_PRICE_LABEL,
  FOUNDING_100_POST_EARLY_BIRD_LABEL,
  subscriptionPriceLine,
  foundersTierLadderPromptBlock,
} from './foundersTiers';
import {
  getFounding100PriceLabel,
  FOUNDING_100_CAP,
  TITLE_FOUNDER_CAP,
} from './secrets';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('tier ladder prompt block derives every price from the shared config', () => {
  const ladder = foundersTierLadderPromptBlock();
  assert.ok(ladder.includes(`($${HERD_MONTHLY_DOLLARS}/mo or $${HERD_ANNUAL_DOLLARS}/yr)`));
  assert.ok(ladder.includes(`($${OUTLAW_MONTHLY_DOLLARS}/mo or $${OUTLAW_ANNUAL_DOLLARS}/yr)`));
  assert.ok(ladder.includes(`($${STEWARD_MONTHLY_DOLLARS}/mo or $${STEWARD_ANNUAL_DOLLARS}/yr)`));
  // Founding 100 quotes the SAME live label the page + checkout use — price
  // truth at the moment of commitment (computed per call, never frozen at
  // module load, so the early-bird flip reaches DMs the moment it reaches
  // /founders).
  assert.ok(
    ladder.includes(`(${getFounding100PriceLabel()} one-time, ${FOUNDING_100_CAP} numbered spots)`)
  );
  assert.ok(ladder.includes(TITLE_FOUNDER_PRICE_LABEL));
  assert.ok(ladder.includes(`${TITLE_FOUNDER_CAP} spots`));
  assert.ok(!ladder.includes('$5k'), 'the dead "$5k+" Title Founder quote must never come back');
});

test('display labels match the charge-side config', () => {
  assert.equal(TITLE_FOUNDER_PRICE_LABEL, '$15,000');
  assert.equal(subscriptionPriceLine(9, 90), '$9 / mo or $90 / yr');
  assert.equal(FOUNDING_100_POST_EARLY_BIRD_LABEL, '$1,500');
});

// Any dollar literal that spells a Founding Herd tier price. "$1" (the
// FOUNDERS_TEST_MODE verification tier) and regex back-references ("$1") are
// deliberately NOT matched.
const PRICE_LITERAL = /\$(9|25|75|90|250|750|1,000|1,500|5,000|15,000|1k|5k|15k)\b/;

test('manychat DM closer carries no hardcoded tier price — config only', () => {
  const src = read('../app/api/webhooks/manychat/route.ts');
  assert.match(src, /from '@\/lib\/foundersTiers'/);
  assert.match(src, /foundersTierLadderPromptBlock/);
  assert.doesNotMatch(
    src,
    PRICE_LITERAL,
    'manychat prompt hardcodes a tier price — interpolate it from lib/foundersTiers'
  );
});

test('/founders page renders tier prices from the shared config only', () => {
  const src = read('../app/founders/page.tsx');
  assert.match(src, /from '@\/lib\/foundersTiers'/);
  assert.doesNotMatch(
    src,
    PRICE_LITERAL,
    '/founders hardcodes a tier price — interpolate it from lib/foundersTiers'
  );
});
