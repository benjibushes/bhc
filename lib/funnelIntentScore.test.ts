// lib/funnelIntentScore.test.ts
// Runner: npm test (tsx --test 'lib/**/*.test.ts')

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFunnelIntentScore, classifyFunnelIntent } from './funnelIntentScore';

const PHONE = '555-555-5555';

test('scorer: hottest honest path lands exactly 100', () => {
  assert.equal(
    computeFunnelIntentScore({
      tier: 'Whole',
      timing: 'Within 30 days',
      budget: '$5000+',
      storage: 'have_freezer',
      phone: PHONE,
    }),
    100,
  );
});

test('scorer: tier weights — whole 30 / half 28 / quarter 22 / not-sure 5', () => {
  const base = { timing: '', budget: 'skip-parse-fail', phone: '' };
  // budget 'skip-parse-fail' is unparseable → 5 pts baseline in every case.
  assert.equal(computeFunnelIntentScore({ ...base, tier: 'Whole' }), 35);
  assert.equal(computeFunnelIntentScore({ ...base, tier: 'Half' }), 33);
  assert.equal(computeFunnelIntentScore({ ...base, tier: 'Quarter' }), 27);
  assert.equal(computeFunnelIntentScore({ ...base, tier: 'Not Sure' }), 10);
  assert.equal(computeFunnelIntentScore({ ...base, tier: '' }), 5);
});

test('scorer: timing — within-30/ASAP 30, within-60 18, exploring 0', () => {
  const base = { tier: '', budget: '', phone: '' }; // budget skipped = 5
  assert.equal(computeFunnelIntentScore({ ...base, timing: 'Within 30 days' }), 35);
  assert.equal(computeFunnelIntentScore({ ...base, timing: 'ASAP' }), 35);
  assert.equal(computeFunnelIntentScore({ ...base, timing: 'Within 60 days' }), 23);
  assert.equal(computeFunnelIntentScore({ ...base, timing: 'Just exploring' }), 5);
  assert.equal(computeFunnelIntentScore({ ...base, timing: '' }), 5);
});

test('scorer: budget — >= $2,500 floor 20, lower 8, skipped/non-committal 5', () => {
  const base = { tier: '', timing: '', phone: '' };
  // Mid-bracket-and-up (funnel chips + legacy spellings)
  assert.equal(computeFunnelIntentScore({ ...base, budget: '2500-3500' }), 20);
  assert.equal(computeFunnelIntentScore({ ...base, budget: '$4000-$5000' }), 20);
  assert.equal(computeFunnelIntentScore({ ...base, budget: '$5000+' }), 20);
  assert.equal(computeFunnelIntentScore({ ...base, budget: '$2,000-$2,500' }), 8); // floor 2000
  // Lower brackets
  assert.equal(computeFunnelIntentScore({ ...base, budget: '$1500-$2500' }), 8);
  assert.equal(computeFunnelIntentScore({ ...base, budget: '$1000-$1500' }), 8);
  assert.equal(computeFunnelIntentScore({ ...base, budget: '<$500' }), 8);
  // Skipped / non-committal
  assert.equal(computeFunnelIntentScore({ ...base, budget: '' }), 5);
  assert.equal(computeFunnelIntentScore({ ...base, budget: undefined }), 5);
  assert.equal(computeFunnelIntentScore({ ...base, budget: 'Just exploring' }), 5);
  assert.equal(computeFunnelIntentScore({ ...base, budget: 'Unsure' }), 5);
  assert.equal(computeFunnelIntentScore({ ...base, budget: '-' }), 5);
});

test('scorer: storage — freezer 10, rancher-holds 8, need-space/cuts 6, unknown 0', () => {
  const base = { tier: '', timing: '', budget: 'x', phone: '' }; // budget unparseable = 5
  assert.equal(computeFunnelIntentScore({ ...base, storage: 'have_freezer' }), 15);
  assert.equal(computeFunnelIntentScore({ ...base, storage: 'rancher_holds' }), 13);
  assert.equal(computeFunnelIntentScore({ ...base, storage: 'need_freezer' }), 11);
  assert.equal(computeFunnelIntentScore({ ...base, storage: 'cuts_only' }), 11);
  assert.equal(computeFunnelIntentScore({ ...base, storage: undefined }), 5);
});

test('scorer: phone — 10-15 digits scores 10, junk scores 0', () => {
  const base = { tier: '', timing: '', budget: 'x' };
  assert.equal(computeFunnelIntentScore({ ...base, phone: '555-555-5555' }), 15);
  assert.equal(computeFunnelIntentScore({ ...base, phone: '+1 (720) 240-1234' }), 15);
  assert.equal(computeFunnelIntentScore({ ...base, phone: '12345' }), 5);
  assert.equal(computeFunnelIntentScore({ ...base, phone: '' }), 5);
  assert.equal(computeFunnelIntentScore({ ...base, phone: undefined }), 5);
});

test('scorer: signup-time shape (no storage yet) caps at 90', () => {
  // At /api/consumers time the funnel hasn't collected storage — the ceiling
  // is 90, still comfortably above the 80 hot-lead alert bar.
  assert.equal(
    computeFunnelIntentScore({
      tier: 'Whole',
      timing: 'Within 30 days',
      budget: '$5000+',
      phone: PHONE,
    }),
    90,
  );
});

test('scorer: never exceeds 100 or drops below 0', () => {
  const max = computeFunnelIntentScore({
    tier: 'Whole', timing: 'ASAP', budget: '$5000+', storage: 'have_freezer', phone: PHONE,
  });
  assert.ok(max <= 100);
  const min = computeFunnelIntentScore({ tier: '', timing: '', budget: 'x', storage: '', phone: '' });
  assert.ok(min >= 0);
});

test('classification: >=80 High, >=60 Medium, else Low (exact Airtable choices)', () => {
  assert.equal(classifyFunnelIntent(100), 'High');
  assert.equal(classifyFunnelIntent(80), 'High');
  assert.equal(classifyFunnelIntent(79), 'Medium');
  assert.equal(classifyFunnelIntent(60), 'Medium');
  assert.equal(classifyFunnelIntent(59), 'Low');
  assert.equal(classifyFunnelIntent(0), 'Low');
});
