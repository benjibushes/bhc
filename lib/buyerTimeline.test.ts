// Tests for lib/buyerTimeline.ts — the pure merge core behind
// GET /api/admin/buyer-timeline. Run:
//   JWT_SECRET=test-secret-ci npx tsx --test lib/buyerTimeline.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTimelineEvents } from './buyerTimeline';

test('merges multiple sources sorted ascending by timestamp', () => {
  const out = mergeTimelineEvents([
    {
      kind: 'email',
      events: [
        { ts: '2026-06-03T10:00:00.000Z', summary: 'Sent: warmup' },
        { ts: '2026-06-01T09:00:00.000Z', summary: 'Sent: welcome' },
      ],
    },
    {
      kind: 'milestone',
      events: [{ ts: '2026-06-02T12:00:00.000Z', summary: 'Deal created' }],
    },
  ]);
  assert.deepEqual(
    out.map((e) => e.summary),
    ['Sent: welcome', 'Deal created', 'Sent: warmup'],
  );
  assert.deepEqual(
    out.map((e) => e.kind),
    ['email', 'milestone', 'email'],
  );
});

test('normalizes parseable timestamps to ISO', () => {
  const out = mergeTimelineEvents([
    { kind: 'funnel', events: [{ ts: '2026-06-01', summary: 'signup' }] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].ts, new Date('2026-06-01').toISOString());
});

test('filters events with garbage / missing timestamps', () => {
  const out = mergeTimelineEvents([
    {
      kind: 'email',
      events: [
        { ts: 'not-a-date', summary: 'bad' },
        { ts: '', summary: 'empty' },
        { ts: null, summary: 'null' },
        { ts: undefined, summary: 'undefined' },
        { ts: '2026-06-01T00:00:00.000Z', summary: 'good' },
      ],
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].summary, 'good');
});

test('dedupes identical kind+ts+summary triples', () => {
  const out = mergeTimelineEvents([
    {
      kind: 'reply',
      events: [
        { ts: '2026-06-01T00:00:00.000Z', summary: 'Buyer replied: hi' },
        { ts: '2026-06-01T00:00:00.000Z', summary: 'Buyer replied: hi' },
      ],
    },
    {
      kind: 'reply',
      events: [{ ts: '2026-06-01T00:00:00.000Z', summary: 'Buyer replied: hi' }],
    },
  ]);
  assert.equal(out.length, 1);
});

test('same ts+summary but different kind is NOT deduped', () => {
  const out = mergeTimelineEvents([
    { kind: 'email', events: [{ ts: '2026-06-01T00:00:00.000Z', summary: 'x' }] },
    { kind: 'sms', events: [{ ts: '2026-06-01T00:00:00.000Z', summary: 'x' }] },
  ]);
  assert.equal(out.length, 2);
});

test('per-event kind overrides the source kind', () => {
  const out = mergeTimelineEvents([
    {
      kind: 'email',
      events: [
        { ts: '2026-06-01T00:00:00.000Z', summary: 'Sent: welcome' },
        { ts: '2026-06-02T00:00:00.000Z', summary: 'Opened', kind: 'email_open' },
      ],
    },
  ]);
  assert.deepEqual(out.map((e) => e.kind), ['email', 'email_open']);
});

test('preserves optional detail field', () => {
  const out = mergeTimelineEvents([
    {
      kind: 'reply',
      events: [
        { ts: '2026-06-01T00:00:00.000Z', summary: 'Reply', detail: 'full body text' },
      ],
    },
  ]);
  assert.equal(out[0].detail, 'full body text');
});

test('empty sources / empty events return an empty array', () => {
  assert.deepEqual(mergeTimelineEvents([]), []);
  assert.deepEqual(mergeTimelineEvents([{ kind: 'email', events: [] }]), []);
});

test('stable deterministic order for equal timestamps (kind then summary)', () => {
  const out = mergeTimelineEvents([
    { kind: 'sms', events: [{ ts: '2026-06-01T00:00:00.000Z', summary: 'b' }] },
    { kind: 'email', events: [{ ts: '2026-06-01T00:00:00.000Z', summary: 'a' }] },
    { kind: 'email', events: [{ ts: '2026-06-01T00:00:00.000Z', summary: 'z' }] },
  ]);
  assert.deepEqual(
    out.map((e) => `${e.kind}:${e.summary}`),
    ['email:a', 'email:z', 'sms:b'],
  );
});
