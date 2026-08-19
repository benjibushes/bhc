// Per-table cache TTL policy (capacity audit 2026-08-19).
//
// WHAT BROKE: lib/airtable.ts used ONE CACHE_TTL_MS = 10s for both cache
// layers and all three cached tables. The Ranchers full-table read therefore
// expired 6x/minute, and every expiry under sustained traffic sent a fresh
// full scan at Airtable — the storm surface.
//
// THE FIX IS A SPLIT, NOT A BLANKET RAISE. The two layers have different jobs
// and therefore different TTLs:
//   L1 (in-process, per lambda) — bounds STALENESS. A write busts L1 only on
//     the instance that performed it; every OTHER instance keeps serving its
//     own L1 copy until it expires. So L1 TTL is the fleet-wide "how long can
//     a just-changed rancher stay invisible" number. It must stay SHORT.
//   L2 (Upstash Redis, shared) — bounds AIRTABLE REQUEST RATE. Writes delete
//     the shared key globally (invalidateAirtableCache → cacheDel), so a long
//     L2 TTL is safe against in-app writes and is what actually collapses the
//     read storm.
//
// These tests pin that split so nobody "simplifies" it back into one number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIRTABLE_CACHE_POLICY,
  CACHEABLE_TABLES,
  isCacheableTable,
  l1TtlMs,
  l2TtlMs,
  MAX_MONEY_PATH_L1_TTL_MS,
  MONEY_PATH_TABLES,
} from './airtableCachePolicy';

test('exactly the three historically-cached tables are cacheable', () => {
  assert.deepEqual(
    [...CACHEABLE_TABLES].sort(),
    ['Ranchers', 'Rancher Products', 'Recommended Products'].sort(),
  );
});

test('money/capacity tables are NOT cacheable — Consumers, Referrals, Payments stay live', () => {
  for (const t of ['Consumers', 'Referrals', 'Payments', 'Rancher Orders', 'Cron Runs', 'Email Sends']) {
    assert.equal(isCacheableTable(t), false, `${t} must never be served from cache`);
    assert.equal(l1TtlMs(t), 0, `${t} must have no L1 TTL`);
    assert.equal(l2TtlMs(t), 0, `${t} must have no L2 TTL`);
  }
});

test('L1 <= L2 for every cached table (L1 bounds staleness, L2 bounds request rate)', () => {
  for (const table of CACHEABLE_TABLES) {
    assert.ok(
      l1TtlMs(table) <= l2TtlMs(table),
      `${table}: L1 ${l1TtlMs(table)}ms must not exceed L2 ${l2TtlMs(table)}ms`,
    );
  }
});

test('MONEY-PATH SAFETY: tables that feed pricing/capacity/routing keep the OLD short L1 TTL', () => {
  // Ranchers decides who is routable/payable and what a buyer is charged;
  // Rancher Products carries Display Price and Rancher Base. A stale row in
  // either is a wrong money decision. Raising their L1 TTL is the one change
  // this policy must never make.
  for (const table of MONEY_PATH_TABLES) {
    assert.ok(CACHEABLE_TABLES.has(table), `${table} should be in the cached set`);
    assert.ok(
      l1TtlMs(table) <= MAX_MONEY_PATH_L1_TTL_MS,
      `${table}: L1 ${l1TtlMs(table)}ms exceeds the ${MAX_MONEY_PATH_L1_TTL_MS}ms money-path ceiling — ` +
        'a stale rancher/price could reach a checkout',
    );
  }
});

test('L2 actually rises — otherwise the Airtable read rate is unchanged and the storm stays', () => {
  // Ranchers is the storm table (/access, matching, signup all full-scan it).
  assert.ok(
    l2TtlMs('Ranchers') >= 6 * l1TtlMs('Ranchers'),
    'Ranchers L2 must be several multiples of L1 or the shared cache buys nothing',
  );
  assert.ok(l2TtlMs('Ranchers') >= 60_000, 'Ranchers L2 should absorb at least a minute of fan-out');
});

test('Recommended Products (no money decision, weekly-fresh content) may cache hardest', () => {
  assert.ok(
    l2TtlMs('Recommended Products') > l2TtlMs('Ranchers'),
    'the pure-content table should have the longest shared TTL',
  );
});

test('every policy entry documents WHY (the next reader must not have to guess)', () => {
  for (const [table, entry] of Object.entries(AIRTABLE_CACHE_POLICY)) {
    assert.ok(entry.why && entry.why.length > 20, `${table}: policy entry needs a real justification`);
    assert.ok(entry.l1Ms > 0 && entry.l2Ms > 0, `${table}: TTLs must be positive`);
  }
});

test('worst-case staleness is bounded and stated (L1 + L2, since an L2 hit re-stamps L1)', () => {
  // A value can sit in L2 until its EX expires and then live another full L1
  // TTL on the instance that pulled it. Nobody should be surprised by that.
  for (const table of CACHEABLE_TABLES) {
    const worst = l1TtlMs(table) + l2TtlMs(table);
    assert.ok(worst <= 10 * 60_000, `${table}: worst-case staleness ${worst}ms is unreasonably long`);
  }
});
