import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateLossReasons, lossReasonLines } from './lossScorecard';

test('aggregates by reason with top-3 sources, count-desc', () => {
  const rows = [
    { lossReason: "Couldn't reach buyer", source: 'funnel' },
    { lossReason: "Couldn't reach buyer", source: 'funnel' },
    { lossReason: "Couldn't reach buyer", source: 'ig' },
    { lossReason: "Couldn't reach buyer", source: 'shop' },
    { lossReason: "Couldn't reach buyer", source: 'map' },
    { lossReason: 'Price too high', source: 'funnel' },
  ];
  const agg = aggregateLossReasons(rows);
  assert.equal(agg.length, 2);
  assert.equal(agg[0].reason, "Couldn't reach buyer");
  assert.equal(agg[0].count, 5);
  // top-3 only, funnel first (2), then alphabetical among the 1s.
  assert.deepEqual(
    agg[0].topSources,
    [
      { source: 'funnel', count: 2 },
      { source: 'ig', count: 1 },
      { source: 'map', count: 1 },
    ],
  );
  assert.equal(agg[1].reason, 'Price too high');
  assert.equal(agg[1].count, 1);
});

test('handles Airtable {name} select objects and blank sources', () => {
  const agg = aggregateLossReasons([
    { lossReason: { name: 'Bought elsewhere' }, source: '' },
    { lossReason: { name: 'Bought elsewhere' }, source: undefined },
  ]);
  assert.equal(agg.length, 1);
  assert.equal(agg[0].count, 2);
  assert.deepEqual(agg[0].topSources, [{ source: 'unknown', count: 2 }]);
});

test('drops rows whose reason is outside the pinned vocabulary', () => {
  const agg = aggregateLossReasons([
    { lossReason: 'Alien abduction', source: 'funnel' },
    { lossReason: '', source: 'funnel' },
    { lossReason: null, source: 'funnel' },
  ]);
  assert.deepEqual(agg, []);
});

test('equal counts tie-break on pinned vocabulary order', () => {
  const agg = aggregateLossReasons([
    { lossReason: 'Bought elsewhere', source: 'a' },
    { lossReason: 'Price too high', source: 'b' },
  ]);
  // 'Price too high' comes first in LOSS_REASON_CHOICES.
  assert.deepEqual(agg.map((a) => a.reason), ['Price too high', 'Bought elsewhere']);
});

test('lossReasonLines renders the scorecard house style', () => {
  const lines = lossReasonLines([
    { lossReason: 'Timing — buying later', source: 'funnel' },
    { lossReason: 'Timing — buying later', source: 'funnel' },
    { lossReason: 'Timing — buying later', source: 'ig' },
  ]);
  assert.deepEqual(lines, [' · Timing — buying later: <b>3</b> (funnel 2, ig 1)']);
});

test('lossReasonLines is empty when nothing qualifies (section omitted)', () => {
  assert.deepEqual(lossReasonLines([]), []);
  assert.deepEqual(lossReasonLines([{ lossReason: 'nope', source: 'x' }]), []);
});
