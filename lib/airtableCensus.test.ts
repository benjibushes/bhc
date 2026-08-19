// Census math + paging (capacity audit 2026-08-19).
//
// The census is the sensor behind the capacity alarm. Two things have to be
// right or the alarm lies: the NET-inflow derivation (gross inflow overstates
// growth wherever retention is deleting, and an alarmist projection gets muted,
// which is how you end up back where we started), and the paging must never
// itself exceed Airtable's request ceiling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCensus, netInflowPerDay, runBaseCensus, type TableCount } from './airtableCensus';

const MEASURED: TableCount[] = [
  { table: 'Email Sends', count: 14_242, createdLast24h: 347 },
  { table: 'Cron Runs', count: 11_521, createdLast24h: 343 },
  { table: 'Consumers', count: 2_774, createdLast24h: 4 },
  { table: 'Funnel Events', count: 2_422, createdLast24h: 35 },
  { table: 'Referrals', count: 1_806, createdLast24h: 7 },
];

test('summarize folds the live 2026-08-19 numbers correctly', () => {
  const s = summarizeCensus(MEASURED);
  assert.equal(s.total, 32_765);
  assert.equal(s.grossInflowPerDay, 736);
  assert.deepEqual(s.biggest.map((b) => b.table), ['Email Sends', 'Cron Runs', 'Consumers', 'Funnel Events']);
});

test('biggest tables are ranked by SIZE, not by inflow — that is where an operator cuts', () => {
  const s = summarizeCensus(
    [
      { table: 'Small But Busy', count: 10, createdLast24h: 5_000 },
      { table: 'Huge And Quiet', count: 30_000, createdLast24h: 1 },
    ],
    1,
  );
  assert.equal(s.biggest[0].table, 'Huge And Quiet');
});

test('an empty base summarizes to zeroes rather than NaN', () => {
  const s = summarizeCensus([]);
  assert.equal(s.total, 0);
  assert.equal(s.grossInflowPerDay, 0);
  assert.deepEqual(s.biggest, []);
});

// ── Net inflow ───────────────────────────────────────────────────────────

const DAY = 86_400_000;

test('net inflow differences against the previous census', () => {
  const now = Date.parse('2026-08-19T04:25:00Z');
  assert.equal(netInflowPerDay({ total: 36_000, at: now - DAY }, 36_345, now), 345);
});

test('net inflow is NEGATIVE when retention is winning — that must be reportable, not clamped', () => {
  const now = Date.parse('2026-08-19T04:25:00Z');
  assert.equal(netInflowPerDay({ total: 40_000, at: now - 2 * DAY }, 39_000, now), -500);
});

test('no baseline ⇒ null, so the caller falls back to the conservative gross number', () => {
  const now = Date.now();
  assert.equal(netInflowPerDay(undefined, 36_451, now), null);
  assert.equal(netInflowPerDay({ total: NaN, at: now - DAY }, 36_451, now), null);
});

test('a too-recent baseline is REFUSED — differencing over minutes invents a wild rate', () => {
  const now = Date.parse('2026-08-19T04:25:00Z');
  // 60 rows in 5 minutes would extrapolate to 17,280/day and page the operator
  // for an outage that isn't happening.
  assert.equal(netInflowPerDay({ total: 36_391, at: now - 5 * 60_000 }, 36_451, now), null);
  // A full day apart is fine.
  assert.equal(netInflowPerDay({ total: 36_391, at: now - DAY }, 36_451, now), 60);
});

// ── Paging ───────────────────────────────────────────────────────────────

function fakeBase(pagesByTable: Record<string, Array<{ records: any[]; offset?: string }>>) {
  const calls: string[] = [];
  const cursor: Record<string, number> = {};
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.includes('/meta/bases/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tables: Object.keys(pagesByTable).map((name) => ({
            name,
            primaryFieldId: 'fld1',
            fields: [{ id: 'fld1', name: 'Name' }],
          })),
        }),
      } as any;
    }
    const table = decodeURIComponent(url.split('/').pop()!.split('?')[0]);
    const i = cursor[table] ?? 0;
    cursor[table] = i + 1;
    const page = pagesByTable[table][i];
    return { ok: true, status: 200, json: async () => page } as any;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function rec(createdTime: string) {
  return { id: 'rec', createdTime };
}

test('counts every page of every table and measures 24h inflow in the same pass', async () => {
  const now = Date.parse('2026-08-19T04:25:00Z');
  const fresh = new Date(now - 3 * 60 * 60 * 1000).toISOString();
  const old = new Date(now - 40 * 86_400_000).toISOString();
  const { fetchImpl } = fakeBase({
    'Email Sends': [
      { records: [rec(fresh), rec(old)], offset: 'p2' },
      { records: [rec(fresh)] },
    ],
    Ranchers: [{ records: [rec(old)] }],
  });

  const out = await runBaseCensus({
    apiKey: 'k',
    baseId: 'b',
    fetchImpl,
    now: () => now,
    sleep: async () => {},
  });

  assert.deepEqual(out.tables, [
    { table: 'Email Sends', count: 3, createdLast24h: 2 },
    { table: 'Ranchers', count: 1, createdLast24h: 1 * 0 },
  ]);
  assert.equal(out.truncated, false);
  assert.equal(out.errors.length, 0);
  assert.equal(out.requests, 4, '1 meta + 2 pages + 1 page');
});

test('PACING: a sleep happens between pages — an unpaced census would cause the outage it watches for', async () => {
  const now = Date.parse('2026-08-19T04:25:00Z');
  const slept: number[] = [];
  const { fetchImpl } = fakeBase({
    T: [{ records: [], offset: 'p2' }, { records: [], offset: 'p3' }, { records: [] }],
  });
  await runBaseCensus({
    apiKey: 'k',
    baseId: 'b',
    pacingMs: 400,
    fetchImpl,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.deepEqual(slept, [400, 400], 'one pause per page boundary, none after the last page');
});

test('a single unreadable table is recorded and skipped — a partial census beats no census', async () => {
  const now = Date.parse('2026-08-19T04:25:00Z');
  const fetchImpl = (async (url: string) => {
    if (url.includes('/meta/bases/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tables: [
            { name: 'Good', primaryFieldId: 'f', fields: [{ id: 'f', name: 'Name' }] },
            { name: 'Bad', primaryFieldId: 'f', fields: [{ id: 'f', name: 'Name' }] },
          ],
        }),
      } as any;
    }
    if (url.includes('Bad')) return { ok: false, status: 403, json: async () => ({}) } as any;
    return { ok: true, status: 200, json: async () => ({ records: [rec(new Date(now).toISOString())] }) } as any;
  }) as unknown as typeof fetch;

  const out = await runBaseCensus({ apiKey: 'k', baseId: 'b', fetchImpl, now: () => now, sleep: async () => {} });
  assert.equal(out.tables.find((t) => t.table === 'Good')!.count, 1);
  assert.equal(out.tables.find((t) => t.table === 'Bad')!.count, 0);
  assert.equal(out.truncated, true, 'an incomplete count must be flagged — an undercount would MUTE the alarm');
  assert.match(out.errors[0], /Bad: HTTP 403/);
});

test('the wall-clock budget stops the census and flags it truncated (never runs past maxDuration)', async () => {
  let t = 0;
  const { fetchImpl } = fakeBase({
    T: Array.from({ length: 50 }, (_, i) => ({ records: [], offset: i < 49 ? `p${i}` : undefined })),
  });
  const out = await runBaseCensus({
    apiKey: 'k',
    baseId: 'b',
    budgetMs: 1_000,
    fetchImpl,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  assert.equal(out.truncated, true);
  assert.ok(out.requests < 50, 'must have stopped early');
});

test('a failing Meta call THROWS — a census that silently counts zero tables would report an empty base', async () => {
  const fetchImpl = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
  await assert.rejects(runBaseCensus({ apiKey: 'k', baseId: 'b', fetchImpl, sleep: async () => {} }), /meta API 401/);
});
