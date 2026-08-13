import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appliedChaseMode,
  planAppliedChase,
  whichTouchIsDue,
  APPLIED_CHASE_MAX_TOUCHES_PER_RUN,
  APPLIED_CHASE_STAGE_FIELD,
  DAY2_MIN_AGE_DAYS,
  DAY5_MIN_AGE_DAYS,
  HANDOFF_MIN_AGE_DAYS,
  LAST_ONBOARDING_NUDGE_FIELD,
  type AppliedChaseStage,
} from './appliedChase';

const NOW = Date.parse('2026-08-12T15:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
/** A fresh applied-cohort row, `ageDays` old, overridable per test. */
function row(ageDays: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    id: `rec${String(seq).padStart(4, '0')}`,
    _createdTime: new Date(NOW - ageDays * DAY).toISOString(),
    'Ranch Name': `Ranch ${seq}`,
    'Operator Name': `Op Erator${seq}`,
    Email: `op${seq}@example.com`,
    State: 'MT',
    'Onboarding Status': '',
    ...overrides,
  };
}

// ── Kill switch — tri-state, FAIL-TO-OFF ────────────────────────────────────

test('appliedChaseMode: only exact "true" is live, only "dry-run" is shadow', () => {
  assert.equal(appliedChaseMode('true'), 'live');
  assert.equal(appliedChaseMode('dry-run'), 'dry-run');
  for (const raw of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'live', 'dryrun']) {
    assert.equal(appliedChaseMode(raw as any), 'off', JSON.stringify(raw));
  }
});

// ── Lane derivation (stage × age) ───────────────────────────────────────────

test('whichTouchIsDue: never-touched rows enter the lane their AGE puts them in', () => {
  assert.equal(whichTouchIsDue('', 0), 'day0');
  assert.equal(whichTouchIsDue('', 1), 'day0');
  assert.equal(whichTouchIsDue('', DAY2_MIN_AGE_DAYS), 'day2');
  assert.equal(whichTouchIsDue('', DAY5_MIN_AGE_DAYS - 1), 'day2');
  assert.equal(whichTouchIsDue('', DAY5_MIN_AGE_DAYS), 'day5');
  assert.equal(whichTouchIsDue('', 23), 'day5'); // the 07-20 casualty class
});

test('whichTouchIsDue: sequence advances and jumps lanes when deferred past a gate', () => {
  assert.equal(whichTouchIsDue('day0-sent', 1), null);
  assert.equal(whichTouchIsDue('day0-sent', 2), 'day2');
  assert.equal(whichTouchIsDue('day0-sent', 6), 'day5'); // deferred day2 jumps
  assert.equal(whichTouchIsDue('day2-sent', 4), null);
  assert.equal(whichTouchIsDue('day2-sent', 5), 'day5');
  assert.equal(whichTouchIsDue('day5-sent', HANDOFF_MIN_AGE_DAYS - 1), null);
  assert.equal(whichTouchIsDue('day5-sent', HANDOFF_MIN_AGE_DAYS), 'handoff');
  assert.equal(whichTouchIsDue('garbage-stage' as AppliedChaseStage, 30), null);
});

// ── Cohort selection ────────────────────────────────────────────────────────

test('plan: a fresh application gets the day-0 touch on the first pass', () => {
  const plan = planAppliedChase([row(0)], NOW);
  assert.equal(plan.actions.length, 1);
  const a = plan.actions[0];
  assert.equal(a.kind, 'send');
  assert.equal(a.touch, 'day0');
  assert.equal(a.nextStage, 'day0-sent');
  assert.equal(a.priorStage, '');
  assert.equal(plan.stops.length, 0);
});

test('plan: Docs Sent rows are IN the cohort; other statuses are out', () => {
  const docsSent = row(10, { 'Onboarding Status': 'Docs Sent' });
  const progressed = row(10, { 'Onboarding Status': 'Call Scheduled' });
  const plan = planAppliedChase([docsSent, progressed], NOW);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].id, docsSent.id);
  assert.equal(plan.actions[0].touch, 'day5'); // old row → day-5 lane
  assert.equal(plan.skips['onboarding-progressed'], 1);
});

test('plan: exclusions — signed, parked, verified, self-submit, escalated, synthetic', () => {
  const rows = [
    row(3, { 'Agreement Signed': true }),
    row(3, { 'Active Status': 'Paused' }),
    row(3, { 'Active Status': 'Non-Compliant' }),
    row(3, { 'Active Status': 'Removed' }),
    row(3, { 'Verification Status': 'Removed' }),
    row(3, { 'Verification Status': 'Verified' }),
    row(3, { 'Self-Submitted At': '2026-08-09T00:00:00Z' }),
    row(3, { 'Stuck Escalated At': '2026-08-01T00:00:00Z' }),
    row(3, { Email: 'probe-audit-99@buyhalfcow.com' }),
  ];
  const plan = planAppliedChase(rows, NOW);
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.skips['agreement-signed'], 1);
  assert.equal(plan.skips['parked'], 4);
  assert.equal(plan.skips['verified'], 1);
  assert.equal(plan.skips['self-submit-rail'], 1);
  assert.equal(plan.skips['already-escalated'], 1);
  assert.equal(plan.skips['synthetic'], 1);
  // None of these were ever claimed → no stop-writes on the first sweep.
  assert.equal(plan.stops.length, 0);
});

test('plan: a row this rail already claimed that leaves the cohort gets a stop flip', () => {
  const signed = row(6, {
    [APPLIED_CHASE_STAGE_FIELD]: 'day2-sent',
    'Agreement Signed': true,
  });
  const plan = planAppliedChase([signed], NOW);
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.stops.length, 1);
  assert.equal(plan.stops[0].id, signed.id);
  assert.equal(plan.stops[0].reason, 'agreement-signed');
});

test('plan: terminal stages never re-select', () => {
  const plan = planAppliedChase(
    [
      row(30, { [APPLIED_CHASE_STAGE_FIELD]: 'handed-off' }),
      row(30, { [APPLIED_CHASE_STAGE_FIELD]: 'stopped' }),
    ],
    NOW,
  );
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.stops.length, 0);
  assert.equal(plan.skips['terminal-stage'], 2);
});

// ── Cross-rail quiet window ─────────────────────────────────────────────────

test('plan: another rail touched <48h ago → defer WITHOUT advancing the stage', () => {
  const quiet = row(3, {
    [LAST_ONBOARDING_NUDGE_FIELD]: new Date(NOW - 12 * 60 * 60 * 1000).toISOString(),
  });
  const loud = row(3, {
    [LAST_ONBOARDING_NUDGE_FIELD]: new Date(NOW - 3 * DAY).toISOString(),
  });
  const plan = planAppliedChase([quiet, loud], NOW);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].id, loud.id);
  assert.equal(plan.skips['cross-rail-quiet'], 1);
});

test('plan: the quiet window does NOT block a handoff (no email involved)', () => {
  const r = row(9, {
    [APPLIED_CHASE_STAGE_FIELD]: 'day5-sent',
    [LAST_ONBOARDING_NUDGE_FIELD]: new Date(NOW - 1 * 60 * 60 * 1000).toISOString(),
  });
  const plan = planAppliedChase([r], NOW);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].kind, 'handoff');
  assert.equal(plan.actions[0].bucket, 'new-applicant');
});

// ── Handoff ─────────────────────────────────────────────────────────────────

test('plan: handoff bucket mirrors the derived stuck bucket', () => {
  const blank = row(9, { [APPLIED_CHASE_STAGE_FIELD]: 'day5-sent' });
  const docs = row(9, {
    [APPLIED_CHASE_STAGE_FIELD]: 'day5-sent',
    'Onboarding Status': 'Docs Sent',
  });
  const plan = planAppliedChase([blank, docs], NOW);
  const byId = new Map(plan.actions.map((a) => [a.id, a]));
  assert.equal(byId.get(blank.id as string)?.bucket, 'new-applicant');
  assert.equal(byId.get(docs.id as string)?.bucket, 'docs-sent');
});

test('plan: dead email channel skips the email lanes and hands off at day 2+', () => {
  const bounced = row(4, { Bounced: true });
  const noEmail = row(4, { Email: '' });
  const unsub = row(4, { Unsubscribed: true });
  const freshNoEmail = row(1, { Email: '' });
  const plan = planAppliedChase([bounced, noEmail, unsub, freshNoEmail], NOW);
  assert.equal(plan.actions.length, 3);
  for (const a of plan.actions) {
    assert.equal(a.kind, 'handoff');
    assert.equal(a.emailDead, true);
  }
  assert.equal(plan.skips['email-dead-too-fresh'], 1);
});

// ── First-sweep coverage ────────────────────────────────────────────────────

test('first sweep: old Docs Sent backlog enters the day-5 lane, never day-0', () => {
  // The 13-row Docs Sent backlog class: created weeks ago, never touched.
  const backlog = Array.from({ length: 13 }, (_, i) =>
    row(12 + i, { 'Onboarding Status': 'Docs Sent' }),
  );
  const plan = planAppliedChase(backlog, NOW);
  assert.equal(plan.actions.length, 13);
  for (const a of plan.actions) {
    assert.equal(a.kind, 'send');
    assert.equal(a.touch, 'day5'); // ONE last-call each — no 3-email sequence
    assert.equal(a.nextStage, 'day5-sent');
  }
});

test('plan: cap + oldest-first — the longest-ignored rows win the slots', () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(i + 2)); // ages 2..31
  const plan = planAppliedChase(rows, NOW);
  assert.equal(plan.actions.length, APPLIED_CHASE_MAX_TOUCHES_PER_RUN);
  assert.equal(plan.skips['over-cap'], 30 - APPLIED_CHASE_MAX_TOUCHES_PER_RUN);
  // Oldest first: ages descend across the capped list.
  const ages = plan.actions.map((a) => a.ageDays);
  assert.deepEqual(ages, [...ages].sort((a, b) => b - a));
  assert.equal(ages[0], 31);
});

test('plan: custom maxTouches is honored', () => {
  const rows = Array.from({ length: 5 }, () => row(3));
  const plan = planAppliedChase(rows, NOW, { maxTouches: 2 });
  assert.equal(plan.actions.length, 2);
  assert.equal(plan.skips['over-cap'], 3);
});

// ── Degraded input ──────────────────────────────────────────────────────────

test('plan: unparseable created time is skipped, never guessed', () => {
  const bad = row(0, { _createdTime: '' });
  const alsoBad = row(0, { _createdTime: 'not-a-date' });
  const future = row(0, { _createdTime: new Date(NOW + 2 * DAY).toISOString() });
  const plan = planAppliedChase([bad, alsoBad, future], NOW);
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.skips['bad-created-time'], 3);
});

test('plan: pure — input rows are not mutated', () => {
  const r = row(3);
  const frozen = JSON.stringify(r);
  planAppliedChase([r], NOW);
  assert.equal(JSON.stringify(r), frozen);
});
