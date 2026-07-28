// H2 (conversion audit 2026-07-28) — progress-display math for the buyer
// funnel. `reveal` is the destination, not a question: counting it in the
// display total made the final commit tap read "Step 6 of 7 · 83%" — telling
// the buyer another question was coming at the exact commit moment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FUNNEL_STEPS, FUNNEL_DISPLAY_STEP_COUNT, funnelProgressPct } from './funnelConfig';

test('reveal is the last configured step (precondition for the display count)', () => {
  assert.equal(FUNNEL_STEPS[FUNNEL_STEPS.length - 1], 'reveal');
});

test('display count excludes reveal', () => {
  assert.equal(FUNNEL_DISPLAY_STEP_COUNT, FUNNEL_STEPS.length - 1);
  // Guard against config drift: today that is 6 displayed steps
  // (size, timing, budget, contact, storage, commit).
  assert.equal(FUNNEL_DISPLAY_STEP_COUNT, 6);
});

test('first step shows 0%', () => {
  assert.equal(funnelProgressPct(0), 0);
});

test('commit — the final displayed step — shows 100%, never 83%', () => {
  const commitIndex = FUNNEL_STEPS.indexOf('commit');
  assert.equal(commitIndex, FUNNEL_DISPLAY_STEP_COUNT - 1);
  assert.equal(funnelProgressPct(commitIndex), 100);
});

test('progress is monotonically increasing across displayed steps', () => {
  let prev = -1;
  for (let i = 0; i < FUNNEL_DISPLAY_STEP_COUNT; i++) {
    const pct = funnelProgressPct(i);
    assert.ok(pct > prev, `step ${i} pct ${pct} should exceed ${prev}`);
    prev = pct;
  }
});

test('reveal index clamps at 100 (progress bar is hidden there anyway)', () => {
  assert.equal(funnelProgressPct(FUNNEL_STEPS.indexOf('reveal')), 100);
});
