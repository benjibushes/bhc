import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  csvEscape,
  csvNeutralizeFormula,
  money,
  dateOnly,
  filterByClosedDate,
  buildEarningsCsv,
  earningsCsvFilename,
  EARNINGS_CSV_HEADERS,
  type EarningsRow,
} from './earningsCsv';
import { BROKER_MATCH_TYPE } from './brokerRail';

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

test('csvNeutralizeFormula prefixes formula-trigger cells', () => {
  assert.equal(csvNeutralizeFormula('=HYPERLINK("http://evil")'), "'=HYPERLINK(\"http://evil\")");
  assert.equal(csvNeutralizeFormula('+1234'), "'+1234");
  assert.equal(csvNeutralizeFormula('-2+3'), "'-2+3");
  assert.equal(csvNeutralizeFormula('@SUM(A1:A9)'), "'@SUM(A1:A9)");
  assert.equal(csvNeutralizeFormula('\tTabbed'), "'\tTabbed");
});

test('csvNeutralizeFormula leaves safe text + empties untouched', () => {
  assert.equal(csvNeutralizeFormula('Jane Buyer'), 'Jane Buyer');
  assert.equal(csvNeutralizeFormula('Smith, John'), 'Smith, John');
  assert.equal(csvNeutralizeFormula(''), '');
  assert.equal(csvNeutralizeFormula(null), '');
});

test('buildEarningsCsv neutralizes a formula-injection buyer name', () => {
  const csv = buildEarningsCsv([row({ buyerName: '=cmd|calc' })]);
  const lines = csv.trimEnd().split('\r\n');
  // Leading = must be defused with a quote so the sheet treats it as text.
  // The cell also contains no comma/quote/newline, so csvEscape won't wrap it.
  assert.match(lines[1], /(^|,)'=cmd\|calc(,|$)/);
  assert.ok(!/(^|,)=cmd\|calc(,|$)/.test(lines[1]));
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

// SLICE E — rail-split "Net to You". tier_v2 commission is charged ON TOP of
// the rancher's price at deposit (buyer pays it) → net = sale amount. Legacy
// output (the default) must be byte-identical to the pre-rail builder.
test('buildEarningsCsv default rail (legacy) is byte-identical to explicit legacy', () => {
  const rows = [row({ saleAmount: 2000, commissionDue: 200 })];
  assert.equal(buildEarningsCsv(rows), buildEarningsCsv(rows, 'legacy'));
  assert.match(buildEarningsCsv(rows).trimEnd().split('\r\n')[1], /2000\.00,200\.00,1800\.00/);
});

test('buildEarningsCsv tier_v2 rail: Net to You = full sale amount', () => {
  const csv = buildEarningsCsv([row({ saleAmount: 2000, commissionDue: 200 })], 'tier_v2');
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], EARNINGS_CSV_HEADERS.join(',')); // headers unchanged
  assert.match(lines[1], /2000\.00,200\.00,2000\.00/); // net = sale (buyer paid commission)
});

test('buildEarningsCsv RAIL-PER-ROW: depositPaidAt decides net, overriding the fallback', () => {
  // fallback 'tier_v2' but the row never paid a deposit → LEGACY net (nets out).
  const offRail = buildEarningsCsv(
    [row({ saleAmount: 2000, commissionDue: 200, depositPaidAt: '' })],
    'tier_v2',
  );
  assert.match(offRail.trimEnd().split('\r\n')[1], /2000\.00,200\.00,1800\.00/);
  // fallback 'legacy' but the row DID pay a deposit → tier_v2 net (full sale).
  const depositRow = buildEarningsCsv(
    [row({ saleAmount: 2000, commissionDue: 200, depositPaidAt: '2026-07-01' })],
    'legacy',
  );
  assert.match(depositRow.trimEnd().split('\r\n')[1], /2000\.00,200\.00,2000\.00/);
});

// Wave C (2026-07-14) — product-order rows in the bookkeeping CSV. Product
// orders (Rancher Orders) never create a Referral, so they carry kind:
// 'product' and an exact netOverride (the settlement-stamped Rancher Payout)
// instead of riding the referral-rail net computation.
test('buildEarningsCsv leads with a Type column defaulting to share', () => {
  const csv = buildEarningsCsv([row()]);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0].split(',')[0], 'Type');
  assert.ok(lines[1].startsWith('share,'));
});

test('buildEarningsCsv product row: Type=product, netOverride wins over any rail', () => {
  const csv = buildEarningsCsv(
    [
      row({
        id: 'ORD-1234',
        kind: 'product',
        orderType: 'Beef Jerky 3-pack',
        saleAmount: 45,
        commissionDue: 6.75,
        netOverride: 38.25,
        // Even a deposit-paid stamp (tier_v2 rail → net = full sale) must not
        // override the known payout — product money never rode the rail.
        depositPaidAt: '2026-07-01',
      }),
    ],
    'tier_v2',
  );
  const lines = csv.trimEnd().split('\r\n');
  assert.ok(lines[1].startsWith('product,ORD-1234,'));
  assert.match(lines[1], /45\.00,6\.75,38\.25/); // net = payout, not sale
});

test('buildEarningsCsv mixes share + product rows without cross-contamination', () => {
  const csv = buildEarningsCsv([
    row({ id: 'refA', saleAmount: 2000, commissionDue: 200 }),
    row({ id: 'ORD-9', kind: 'product', saleAmount: 100, commissionDue: 15, netOverride: 85 }),
  ]);
  const lines = csv.trimEnd().split('\r\n');
  assert.match(lines[1], /^share,refA,.*2000\.00,200\.00,1800\.00/);
  assert.match(lines[2], /^product,ORD-9,.*100\.00,15\.00,85\.00/);
});

// ── BROKER rows (money-truth reads wave, 2026-08-18) ─────────────────────────
// Broker rail money model (#523): the buyer's deposit goes 100% to BHC and IS
// the entire fee; the ranch collects price − deposit at pickup; no commission
// invoice ever. The CSV — a tax-adjacent document — must net broker rows that
// way: paid-deposit → sale − deposit (a Deposit Paid At stamp otherwise reads
// tier_v2 → full sale, OVERSTATED by the deposit BHC kept); hand-closed unpaid
// → full sale (a legacy read subtracts a phantom Commission Due, UNDERSTATED).

test('buildEarningsCsv BROKER paid-deposit row: Net = sale − the deposit BHC kept; Commission = the deposit', () => {
  const csv = buildEarningsCsv(
    [
      row({
        matchType: BROKER_MATCH_TYPE,
        saleAmount: 3000,
        commissionDue: 0, // never written on this rail
        depositPaidAt: '2026-08-10T12:00:00.000Z',
        bhcFeeCents: 50000, // the whole $500 deposit, stamped at settle
        depositAmount: 500,
      }),
    ],
    'legacy',
  );
  const lines = csv.trimEnd().split('\r\n');
  // Sale 3000.00, Commission 500.00 (the deposit IS the fee), Net 2500.00 —
  // Sale − Commission = Net holds for the sheet.
  assert.match(lines[1], /3000\.00,500\.00,2500\.00/);
});

test('buildEarningsCsv BROKER hand-closed (deposit never paid): Net = FULL sale, phantom Commission Due scrubbed', () => {
  const csv = buildEarningsCsv(
    [
      row({
        matchType: BROKER_MATCH_TYPE,
        saleAmount: 3000,
        commissionDue: 300, // phantom, written by a pre-belt hand-close
        depositPaidAt: '',
      }),
    ],
    'legacy',
  );
  const lines = csv.trimEnd().split('\r\n');
  // BHC collected nothing and the agreement says "never invoiced" — the tax
  // file must show Commission 0.00 and Net = the full sale.
  assert.match(lines[1], /3000\.00,0\.00,3000\.00/);
});

test('buildEarningsCsv BROKER paid row missing the fee stamp falls back to Deposit Amount', () => {
  const csv = buildEarningsCsv([
    row({
      matchType: BROKER_MATCH_TYPE,
      saleAmount: 3000,
      commissionDue: 0,
      depositPaidAt: '2026-08-10T12:00:00.000Z',
      bhcFeeCents: 0, // partial hand-fix: fee stamp lost
      depositAmount: 450,
    }),
  ]);
  assert.match(csv.trimEnd().split('\r\n')[1], /3000\.00,450\.00,2550\.00/);
});

test('buildEarningsCsv BROKER rows ignore fallbackRail entirely', () => {
  const brokerRow = row({
    matchType: BROKER_MATCH_TYPE,
    saleAmount: 3000,
    commissionDue: 300,
    depositPaidAt: '',
  });
  assert.equal(buildEarningsCsv([brokerRow], 'legacy'), buildEarningsCsv([brokerRow], 'tier_v2'));
});

test('buildEarningsCsv non-broker rows are byte-identical with matchType present-but-not-broker', () => {
  const a = buildEarningsCsv([row({ matchType: '' })]);
  const b = buildEarningsCsv([row({ matchType: 'Nearest Match' })]);
  const c = buildEarningsCsv([row()]);
  assert.equal(a, c);
  assert.equal(b, c);
});

// Money-truth trail (2026-07-28): the settled final-invoice amount rides the
// bookkeeping file as a trailing display-only column.
test('buildEarningsCsv ends with a Final Paid Amount column', () => {
  const csv = buildEarningsCsv([row({ finalPaidAmount: 1250 })]);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0].split(',').pop(), 'Final Paid Amount');
  assert.equal(lines[1].split(',').pop(), '1250.00');
});

test('buildEarningsCsv leaves Final Paid Amount BLANK when unknown (not 0.00)', () => {
  // Blank = "no final-invoice settlement recorded" — 0.00 would read as a
  // real $0 payment in a tax file.
  const csv = buildEarningsCsv([row()]);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[1].split(',').pop(), '');
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
