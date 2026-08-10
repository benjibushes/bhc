// lib/dialOutcome.test.ts
//
// C1 — pins the outcome→field matrix so the endpoint can stay a thin applier.
// Every field name asserted here is schema-verified (see lib/dialOutcome.ts
// header). All fixtures synthetic (public repo).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planDialOutcome,
  F_LAST_CONTACTED,
  F_NEXT_FOLLOW_UP_AT,
  F_CALLBACK_HANDLED_AT,
  F_LAST_CHASED_AT,
  F_LAST_TOUCH_AT,
  F_LAST_TOUCH_NOTE,
} from './dialOutcome';

const NOW_ISO = '2026-08-10T18:00:00.000Z';
const TODAY = '2026-08-10';

const base = { nowIso: NOW_ISO, today: TODAY } as const;

test('buyer talked stamps Last Contacted; closes an open callback; optional promise', () => {
  const r = planDialOutcome({ ...base, kind: 'buyer', outcome: 'talked', hasOpenCallback: true, followUpDays: 3 });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.plan.consumer, {
    [F_LAST_CONTACTED]: NOW_ISO,
    [F_CALLBACK_HANDLED_AT]: NOW_ISO,
    [F_NEXT_FOLLOW_UP_AT]: '2026-08-13',
  });
  assert.equal(r.plan.referral, undefined);
});

test('buyer no-answer promises a retry tomorrow and does NOT stamp Last Contacted', () => {
  const r = planDialOutcome({ ...base, kind: 'buyer', outcome: 'no-answer' });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.plan.consumer, { [F_NEXT_FOLLOW_UP_AT]: '2026-08-11' });
});

test('buyer skip defers a week; a deposit-opened row also resets the referral chase clock', () => {
  const r = planDialOutcome({ ...base, kind: 'buyer', outcome: 'skip', hasReferral: true });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.plan.consumer, { [F_NEXT_FOLLOW_UP_AT]: '2026-08-17' });
  assert.deepEqual(r.plan.referral, { [F_LAST_CHASED_AT]: NOW_ISO });
});

test('promise talked without a new date clears the promise (done semantics)', () => {
  const r = planDialOutcome({ ...base, kind: 'promise', outcome: 'talked' });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.plan.consumer, {
    [F_LAST_CONTACTED]: NOW_ISO,
    [F_NEXT_FOLLOW_UP_AT]: null,
  });
});

test('promise skip drops the promise without a contact stamp', () => {
  const r = planDialOutcome({ ...base, kind: 'promise', outcome: 'skip' });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.plan.consumer, { [F_NEXT_FOLLOW_UP_AT]: null });
});

test('deal outcomes stamp Last Chased At; talked+N adds the buyer promise', () => {
  for (const outcome of ['no-answer', 'skip'] as const) {
    const r = planDialOutcome({ ...base, kind: 'deal', outcome });
    assert.ok(r.ok);
    if (!r.ok) continue;
    assert.deepEqual(r.plan.referral, { [F_LAST_CHASED_AT]: NOW_ISO });
    assert.equal(r.plan.consumer, undefined);
  }
  const talked = planDialOutcome({ ...base, kind: 'deal', outcome: 'talked', followUpDays: 7 });
  assert.ok(talked.ok);
  if (!talked.ok) return;
  assert.deepEqual(talked.plan.referral, { [F_LAST_CHASED_AT]: NOW_ISO });
  assert.deepEqual(talked.plan.consumer, { [F_NEXT_FOLLOW_UP_AT]: '2026-08-17' });
});

test('rancher outcomes stamp Last Touch At + an auditable note', () => {
  const r = planDialOutcome({ ...base, kind: 'rancher', outcome: 'no-answer' });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.plan.rancher?.[F_LAST_TOUCH_AT], NOW_ISO);
  assert.match(String(r.plan.rancher?.[F_LAST_TOUCH_NOTE]), /no answer/);
  assert.match(String(r.plan.rancher?.[F_LAST_TOUCH_NOTE]), /cockpit/);
});

test('rejects bad kinds, outcomes, and follow-up days', () => {
  assert.equal(planDialOutcome({ ...base, kind: 'x' as any, outcome: 'talked' }).ok, false);
  assert.equal(planDialOutcome({ ...base, kind: 'buyer', outcome: 'y' as any }).ok, false);
  assert.equal(
    planDialOutcome({ ...base, kind: 'buyer', outcome: 'talked', followUpDays: 5 }).ok,
    false,
  );
  // followUpDays only rides a talked outcome.
  assert.equal(
    planDialOutcome({ ...base, kind: 'buyer', outcome: 'skip', followUpDays: 3 }).ok,
    false,
  );
});
