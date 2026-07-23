import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateStuckOnboarding } from './route';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

test('blank Onboarding Status older than 2 days is bucketed', () => {
  const ranchers = [
    { id: 'r1', 'Ranch Name': 'Old Blank', 'Onboarding Status': '', _createdTime: daysAgo(3) },
    { id: 'r2', 'Ranch Name': 'Fresh Blank', 'Onboarding Status': '', _createdTime: daysAgo(1) },
  ];
  const out = aggregateStuckOnboarding(ranchers, NOW);
  assert.deepEqual(out.blankOver2d.map((r) => r.id), ['r1']);
  assert.equal(out.blankOver2d[0].daysOld, 3);
});

test('a rancher with an Onboarding Status set is never in the blank bucket', () => {
  const ranchers = [
    { id: 'r1', 'Onboarding Status': 'Docs Sent', _createdTime: daysAgo(10) },
  ];
  assert.equal(aggregateStuckOnboarding(ranchers, NOW).blankOver2d.length, 0);
});

test('signed-but-not-live is bucketed; signed-and-live is not', () => {
  const ranchers = [
    { id: 'r1', 'Operator Name': 'Signed Dark', 'Agreement Signed': true, 'Page Live': false },
    { id: 'r2', 'Operator Name': 'Signed Live', 'Agreement Signed': true, 'Page Live': true },
    { id: 'r3', 'Operator Name': 'Unsigned', 'Agreement Signed': false, 'Page Live': false },
  ];
  const out = aggregateStuckOnboarding(ranchers, NOW);
  assert.deepEqual(out.signedNotLive.map((r) => r.id), ['r1']);
});

test('Welcome Email Failed At set is bucketed', () => {
  const ranchers = [
    { id: 'r1', 'Ranch Name': 'Failed', 'Welcome Email Failed At': daysAgo(1) },
    { id: 'r2', 'Ranch Name': 'Ok' },
  ];
  const out = aggregateStuckOnboarding(ranchers, NOW);
  assert.deepEqual(out.welcomeFailed.map((r) => r.id), ['r1']);
});

test('a rancher can appear in multiple buckets independently', () => {
  const ranchers = [
    {
      id: 'r1',
      'Operator Name': 'Multi',
      'Onboarding Status': '',
      _createdTime: daysAgo(5),
      'Agreement Signed': true,
      'Page Live': false,
      'Welcome Email Failed At': daysAgo(4),
    },
  ];
  const out = aggregateStuckOnboarding(ranchers, NOW);
  assert.equal(out.blankOver2d.length, 1);
  assert.equal(out.signedNotLive.length, 1);
  assert.equal(out.welcomeFailed.length, 1);
});

test('a missing _createdTime cannot crash or mis-bucket the blank cohort', () => {
  const ranchers = [{ id: 'r1', 'Onboarding Status': '' }];
  assert.equal(aggregateStuckOnboarding(ranchers, NOW).blankOver2d.length, 0);
});

test('name falls back Operator → Ranch → id', () => {
  const out = aggregateStuckOnboarding(
    [{ id: 'rec123', 'Agreement Signed': true, 'Page Live': false }],
    NOW,
  );
  assert.equal(out.signedNotLive[0].name, 'rec123');
});

test('empty input yields empty buckets', () => {
  const out = aggregateStuckOnboarding([], NOW);
  assert.deepEqual(out, { blankOver2d: [], signedNotLive: [], welcomeFailed: [] });
});
