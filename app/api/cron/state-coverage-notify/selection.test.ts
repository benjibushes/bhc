import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectStateCoverageTargets, DEFAULT_NOTIFY_CAP } from './selection';

const MT = new Set(['MT']);

test('selects a waitlist buyer whose state is now covered', () => {
  const targets = selectStateCoverageTargets(
    [{ id: 'rec1', Email: 'Fam@Example.com', 'Full Name': 'Jo Buyer', State: 'MT' }],
    MT,
  );
  assert.deepEqual(targets, [
    { consumerId: 'rec1', email: 'fam@example.com', firstName: 'Jo', state: 'MT' },
  ]);
});

test('normalizes full state names ("Montana" → MT)', () => {
  const targets = selectStateCoverageTargets(
    [{ id: 'rec1', Email: 'a@x.com', State: 'Montana' }],
    MT,
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0].state, 'MT');
});

test('skips uncovered states, missing email, missing state', () => {
  const targets = selectStateCoverageTargets(
    [
      { id: 'recTX', Email: 'a@x.com', State: 'TX' }, // not covered
      { id: 'recNoEmail', State: 'MT' }, // no email
      { id: 'recNoState', Email: 'b@x.com' }, // no state
      { id: 'recBadState', Email: 'c@x.com', State: 'not-a-state' },
    ],
    MT,
  );
  assert.equal(targets.length, 0);
});

test('skips suppressed rows (unsubscribed / bounced / complained)', () => {
  const targets = selectStateCoverageTargets(
    [
      { id: 'r1', Email: 'a@x.com', State: 'MT', Unsubscribed: true },
      { id: 'r2', Email: 'b@x.com', State: 'MT', Bounced: true },
      { id: 'r3', Email: 'c@x.com', State: 'MT', Complained: true },
      { id: 'r4', Email: 'd@x.com', State: 'MT' },
    ],
    MT,
  );
  assert.deepEqual(targets.map((t) => t.consumerId), ['r4']);
});

test('never greets with the "(waitlist signup)" placeholder name', () => {
  const targets = selectStateCoverageTargets(
    [{ id: 'r1', Email: 'a@x.com', 'Full Name': '(waitlist signup)', State: 'MT' }],
    MT,
  );
  assert.equal(targets[0].firstName, '');
});

test('caps at 50 per run by default', () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({
    id: `rec${i}`,
    Email: `b${i}@x.com`,
    State: 'MT',
  }));
  const targets = selectStateCoverageTargets(rows, MT);
  assert.equal(targets.length, DEFAULT_NOTIFY_CAP);
  assert.equal(DEFAULT_NOTIFY_CAP, 50);
});

test('cap override respected and deterministic order preserved', () => {
  const rows = [
    { id: 'r1', Email: 'a@x.com', State: 'MT' },
    { id: 'r2', Email: 'b@x.com', State: 'MT' },
    { id: 'r3', Email: 'c@x.com', State: 'MT' },
  ];
  const targets = selectStateCoverageTargets(rows, MT, 2);
  assert.deepEqual(targets.map((t) => t.consumerId), ['r1', 'r2']);
});
