import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateStuckOnboarding, aggregateMonthToDate, buildFollowUpBlock } from './route';
import type { DueFollowUp } from '@/lib/followUpQueue';

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

// ── aggregateMonthToDate (Wave 1C: absorbed from daily-digest) ────────────

test('month-to-date counts only Closed Won closed this calendar month', () => {
  const refs = [
    { Status: 'Closed Won', 'Closed At': '2026-07-05T10:00:00.000Z', 'Commission Due': 200 },
    { Status: 'Closed Won', 'Closed At': '2026-07-20T10:00:00.000Z', 'Commission Due': 150.5 },
    { Status: 'Closed Won', 'Closed At': '2026-06-30T10:00:00.000Z', 'Commission Due': 999 }, // prior month
    { Status: 'Closed Lost', 'Closed At': '2026-07-10T10:00:00.000Z', 'Commission Due': 50 }, // wrong status
    { Status: 'Closed Won' }, // no Closed At
  ];
  const out = aggregateMonthToDate(refs, NOW);
  assert.equal(out.wins, 2);
  assert.equal(out.commission, 350.5);
});

test('month-to-date is empty-safe and bad-data-safe', () => {
  assert.deepEqual(aggregateMonthToDate([], NOW), { wins: 0, commission: 0 });
  const out = aggregateMonthToDate(
    [{ Status: 'Closed Won', 'Closed At': 'not-a-date', 'Commission Due': 'NaN' }],
    NOW,
  );
  assert.deepEqual(out, { wins: 0, commission: 0 });
});

// ── buildFollowUpBlock (Wave 1C: absorbed from daily-digest) ──────────────

const due = (over: Partial<DueFollowUp>): DueFollowUp => ({
  id: 'c1',
  name: 'Test Buyer',
  email: 't@example.com',
  phone: '',
  state: 'CO',
  notes: '',
  dueAt: '2026-07-23',
  daysOverdue: 0,
  ...over,
});

test('follow-up block is EMPTY (not "0 due") on a day with no promises', () => {
  assert.equal(buildFollowUpBlock([]), '');
});

test('follow-up block renders name, phone fallback, and overdue marker', () => {
  const block = buildFollowUpBlock([
    due({ name: 'A Buyer', phone: '555-0100', daysOverdue: 2 }),
    due({ id: 'c2', name: 'B Buyer' }),
  ]);
  assert.match(block, /Follow up today \(2\)/);
  assert.match(block, /A Buyer · 555-0100 <i>\(2d late\)<\/i>/);
  assert.match(block, /B Buyer · no phone/);
});

test('follow-up block collapses past the line cap with a "+N more" tail', () => {
  const many = Array.from({ length: 13 }, (_, i) => due({ id: `c${i}`, name: `Buyer ${i}` }));
  const block = buildFollowUpBlock(many);
  assert.match(block, /Follow up today \(13\)/);
  assert.match(block, /\+3 more on the desk/);
});

test('follow-up block HTML-escapes buyer-supplied text', () => {
  const block = buildFollowUpBlock([due({ name: '<b>Sneaky</b> & Co' })]);
  assert.match(block, /&lt;b&gt;Sneaky&lt;\/b&gt; &amp; Co/);
});
