import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  csvEscape,
  money,
  dateOnly,
  filterByClosedDate,
  buildEarningsCsv,
  earningsCsvFilename,
  EARNINGS_CSV_HEADERS,
  type EarningsRow,
} from './earningsCsv';

function row(over: Partial<EarningsRow> = {}): EarningsRow {
  return {
    id: 'rec1',
    buyerName: 'Jane Buyer',
    orderType: 'Half',
    saleAmount: 2000,
    commissionDue: 200,
    closedAt: '2026-06-15T10:00:00.000Z',
    introSentAt: '2026-06-01T10:00:00.000Z',
    ...over,
  };
}

test('csvEscape leaves clean values untouched', () => {
  assert.equal(csvEscape('Jane'), 'Jane');
  assert.equal(csvEscape(2000), '2000');
});

test('csvEscape wraps + doubles quotes for comma/quote/newline', () => {
  assert.equal(csvEscape('Smith, John'), '"Smith, John"');
  assert.equal(csvEscape('he said "hi"'), '"he said ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
});

test('money formats to 2dp, guards NaN', () => {
  assert.equal(money(2000), '2000.00');
  assert.equal(money(NaN), '0.00');
  assert.equal(money(199.5), '199.50');
});

test('dateOnly extracts YYYY-MM-DD, empty on bad/blank', () => {
  assert.equal(dateOnly('2026-06-15T10:00:00.000Z'), '2026-06-15');
  assert.equal(dateOnly(''), '');
  assert.equal(dateOnly('not-a-date'), '');
  assert.equal(dateOnly(undefined), '');
});

test('buildEarningsCsv emits header + escaped rows', () => {
  const csv = buildEarningsCsv([row({ buyerName: 'Smith, John', saleAmount: 2000, commissionDue: 200 })]);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], EARNINGS_CSV_HEADERS.join(','));
  assert.match(lines[1], /"Smith, John"/);
  assert.match(lines[1], /2000\.00,200\.00,1800\.00/); // net = sale - commission
});

test('buildEarningsCsv ends with CRLF', () => {
  const csv = buildEarningsCsv([row()]);
  assert.ok(csv.endsWith('\r\n'));
});

test('filterByClosedDate: no bounds returns a copy of all rows', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b' })];
  const out = filterByClosedDate(rows);
  assert.equal(out.length, 2);
  assert.notEqual(out, rows); // copy, not same ref
});

test('filterByClosedDate honors inclusive from/to', () => {
  const rows = [
    row({ id: 'before', closedAt: '2026-05-01T00:00:00Z' }),
    row({ id: 'in', closedAt: '2026-06-15T00:00:00Z' }),
    row({ id: 'after', closedAt: '2026-07-20T00:00:00Z' }),
  ];
  const out = filterByClosedDate(rows, '2026-06-01', '2026-06-30');
  assert.deepEqual(out.map((r) => r.id), ['in']);
});

test('filterByClosedDate is inclusive on the boundary day', () => {
  const rows = [row({ id: 'edge', closedAt: '2026-06-30T18:00:00Z' })];
  const out = filterByClosedDate(rows, '2026-06-01', '2026-06-30');
  assert.equal(out.length, 1);
});

test('filterByClosedDate drops undatable rows when bounded', () => {
  const rows = [row({ id: 'bad', closedAt: '' }), row({ id: 'good' })];
  const out = filterByClosedDate(rows, '2026-06-01', null);
  assert.deepEqual(out.map((r) => r.id), ['good']);
});

test('filterByClosedDate keeps undatable rows when unbounded', () => {
  const rows = [row({ id: 'bad', closedAt: '' })];
  const out = filterByClosedDate(rows);
  assert.equal(out.length, 1);
});

test('earningsCsvFilename sanitizes + date-stamps', () => {
  assert.equal(earningsCsvFilename('renick-ranch'), 'buyhalfcow-earnings_renick-ranch.csv');
  assert.equal(
    earningsCsvFilename('renick/../etc', '2026-01-01', '2026-12-31'),
    'buyhalfcow-earnings_renick----etc_2026-01-01_to_2026-12-31.csv',
  );
});
