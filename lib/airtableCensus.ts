// lib/airtableCensus.ts
//
// COUNTING THE BASE (capacity audit 2026-08-19).
//
// Airtable exposes no record-count endpoint, so the only way to know how close
// the base is to its 50,000-record cap is to page every table and count. This
// module does that as cheaply as it can:
//   • one Meta API call gets every table and its primary field, so the census
//     automatically covers tables added later — a capacity watch that has to be
//     manually taught about new tables is a capacity watch that goes stale;
//   • each table is paged with a ONE-FIELD projection at pageSize=100, so
//     ~36,000 records cost ~370 requests and almost no bandwidth;
//   • requests are explicitly PACED. This is the whole point of the exercise —
//     a census that trips Airtable's ~5 req/s ceiling would cause the exact
//     outage it is meant to warn about.
// `createdTime` comes back on every record for free, so the same pass measures
// how many rows landed in the last 24h without a second query.
//
// NET vs GROSS inflow: gross 24h inflow overstates growth wherever retention is
// deleting, which would make the days-to-cap projection alarmist. So the census
// stores its total in the shared Redis cache and derives NET inflow by
// differencing against the previous run. With no baseline (first run, or
// Upstash unset) it falls back to the gross 24h count, which is conservative in
// the safe direction — it can only make the alarm fire EARLIER.

import { cacheGet, cacheSet } from './sharedCache';

export interface TableCount {
  table: string;
  count: number;
  createdLast24h: number;
}

export interface CensusSummary {
  total: number;
  /** Rows created in the last 24h across every table (gross). */
  grossInflowPerDay: number;
  /** Biggest tables first — where an operator would actually cut. */
  biggest: Array<{ table: string; count: number }>;
}

/** Pure: fold per-table counts into the numbers the alarm needs. */
export function summarizeCensus(tables: TableCount[], topN = 4): CensusSummary {
  const total = tables.reduce((a, t) => a + t.count, 0);
  const grossInflowPerDay = tables.reduce((a, t) => a + t.createdLast24h, 0);
  const biggest = [...tables]
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
    .map((t) => ({ table: t.table, count: t.count }));
  return { total, grossInflowPerDay, biggest };
}

export interface Baseline {
  total: number;
  at: number; // epoch ms
}

/**
 * Pure: NET rows/day from the previous census. Returns null when there is no
 * usable baseline (caller falls back to gross). A baseline younger than ~6h is
 * ignored — differencing over a few minutes turns rounding into a wild rate.
 */
export function netInflowPerDay(
  baseline: Baseline | undefined,
  total: number,
  now: number,
): number | null {
  if (!baseline || !Number.isFinite(baseline.total) || !Number.isFinite(baseline.at)) return null;
  const elapsedMs = now - baseline.at;
  const MIN_ELAPSED_MS = 6 * 60 * 60 * 1000;
  if (elapsedMs < MIN_ELAPSED_MS) return null;
  const days = elapsedMs / 86_400_000;
  return Math.round((total - baseline.total) / days);
}

const BASELINE_KEY = 'airtable:census:baseline';
/** Long enough to survive a few missed runs, short enough to never go stale-forever. */
const BASELINE_TTL_MS = 8 * 86_400_000;

export async function readCensusBaseline(): Promise<Baseline | undefined> {
  return await cacheGet<Baseline>(BASELINE_KEY);
}

export async function writeCensusBaseline(total: number, at: number): Promise<void> {
  await cacheSet(BASELINE_KEY, { total, at } satisfies Baseline, BASELINE_TTL_MS);
}

// ── The network leg ──────────────────────────────────────────────────────

export interface CensusOptions {
  apiKey: string;
  baseId: string;
  /** Delay between page requests. Must keep the census under half the 5 req/s ceiling. */
  pacingMs?: number;
  /** Hard wall-clock stop so the census can never outrun the route's maxDuration. */
  budgetMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface CensusResult {
  tables: TableCount[];
  requests: number;
  /** True when the budget ran out before every table was fully counted. */
  truncated: boolean;
  errors: string[];
}

const DEFAULT_CENSUS_PACING_MS = 400; // 2.5 req/s — half the per-base ceiling
const DEFAULT_CENSUS_BUDGET_MS = 240_000;

/**
 * Page every table in the base and count rows. Never throws for a single bad
 * table — it records the error and moves on, because a partial census that
 * says "I could not read Deal Events" is far more useful than no census.
 */
export async function runBaseCensus(opts: CensusOptions): Promise<CensusResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pacingMs = opts.pacingMs ?? DEFAULT_CENSUS_PACING_MS;
  const budgetMs = opts.budgetMs ?? DEFAULT_CENSUS_BUDGET_MS;
  const startedAt = now();
  const headers = { Authorization: `Bearer ${opts.apiKey}` };

  const errors: string[] = [];
  let requests = 0;
  let truncated = false;

  // 1. Schema: every table + its primary field, so the projection is valid and
  //    new tables are counted without anyone remembering to add them here.
  const metaRes = await doFetch(
    `https://api.airtable.com/v0/meta/bases/${encodeURIComponent(opts.baseId)}/tables`,
    { headers },
  );
  requests += 1;
  if (!metaRes.ok) {
    throw new Error(`census: meta API ${metaRes.status}`);
  }
  const meta = (await metaRes.json()) as {
    tables: Array<{ name: string; primaryFieldId: string; fields: Array<{ id: string; name: string }> }>;
  };
  const schema = meta.tables.map((t) => ({
    name: t.name,
    primary: t.fields.find((f) => f.id === t.primaryFieldId)?.name,
  }));

  // 2. Count.
  const cutoff24h = now() - 86_400_000;
  const tables: TableCount[] = [];
  for (const { name, primary } of schema) {
    let count = 0;
    let createdLast24h = 0;
    let offset: string | undefined;
    let complete = true;
    for (;;) {
      if (now() - startedAt >= budgetMs) {
        truncated = true;
        complete = false;
        break;
      }
      const q = new URLSearchParams({ pageSize: '100' });
      // A one-field projection makes the response tiny. Without a known
      // primary field we fall back to the full row — correct, just heavier.
      if (primary) q.set('fields[]', primary);
      if (offset) q.set('offset', offset);
      const url = `https://api.airtable.com/v0/${encodeURIComponent(opts.baseId)}/${encodeURIComponent(name)}?${q}`;
      let page: { records?: Array<{ createdTime?: string }>; offset?: string };
      try {
        const res = await doFetch(url, { headers });
        requests += 1;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        page = await res.json();
      } catch (e: any) {
        errors.push(`${name}: ${e?.message || 'read failed'}`);
        complete = false;
        break;
      }
      const recs = page.records || [];
      count += recs.length;
      for (const r of recs) {
        if (r.createdTime && Date.parse(r.createdTime) >= cutoff24h) createdLast24h += 1;
      }
      offset = page.offset;
      if (!offset) break;
      await sleep(pacingMs);
    }
    tables.push({ table: name, count, createdLast24h });
    if (!complete) truncated = true;
  }

  return { tables, requests, truncated, errors };
}
