// lib/adminSnapshot.ts
//
// Shared "admin snapshot" cache (runtime audit 2026-07-28 — the July-timeout
// killer). /api/admin/health, /admin/command-center, /admin/analytics and
// /admin/referrals/stats each independently full-scanned the same 4-5 big
// tables (Consumers ~2.6k rows ≈ 27 paginated requests, Referrals, Payments,
// Cron Runs…) on every open — stacking straight into the Airtable 5 req/s
// per-base ceiling that produced 5 production cron timeouts in July.
//
// Pattern copied from app/api/admin/stuck-ranchers/route.ts:44-64 (the audit's
// cleanest reference), generalized:
//   L1 — module-scope per-lambda memo (TTL below) + in-flight coalescing, so
//        a burst of admin tiles on one warm instance costs ONE read.
//   L2 — lib/sharedCache (Upstash Redis, fail-open no-op when unset) so cold
//        instances share the snapshot instead of each re-scanning Airtable.
//   Never cache empty/null results — a degraded read must not pin every admin
//   board to zeros for the TTL (same rule as stuck-ranchers' demand map).
//
// Admin dashboards are stale-tolerant by design: 3 minutes of staleness on an
// operator board is invisible; the request-storm it prevents is not. Anything
// that needs live-correct data (capacity bumps, money writes) must NOT read
// through this — keep using getAllRecords/getFirstRecord directly.

import { getAllRecords } from './airtable';
import { cacheGet, cacheSet } from './sharedCache';

const DEFAULT_TTL_MS = 3 * 60 * 1000;

type Entry = { ts: number; data: unknown };
const _l1 = new Map<string, Entry>();
const _inflight = new Map<string, Promise<unknown>>();

function isCacheable(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

export async function adminSnapshot<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  const hit = _l1.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data as T;

  const inflight = _inflight.get(key);
  if (inflight) return inflight as Promise<T>;

  const p = (async (): Promise<T> => {
    // L2: another instance may have snapshotted already. Fail-open: cacheGet
    // returns undefined when Upstash is unset or errors.
    const redisKey = `admin:snapshot:${key}`;
    try {
      const shared = await cacheGet<T>(redisKey);
      if (shared !== undefined && isCacheable(shared)) {
        _l1.set(key, { ts: Date.now(), data: shared });
        return shared;
      }
    } catch {
      /* fail open to the real read */
    }

    const data = await fetcher();
    if (isCacheable(data)) {
      _l1.set(key, { ts: Date.now(), data });
      // cacheSet is fail-safe internally (never throws); belt-and-suspenders.
      await cacheSet(redisKey, data, ttlMs).catch(() => {});
    }
    return data;
  })();

  _inflight.set(key, p);
  try {
    return await p;
  } finally {
    _inflight.delete(key);
  }
}

/**
 * Full-table read through the snapshot. The workhorse swap for the admin
 * aggregator routes: `getAllRecords(TABLES.X)` → `adminSnapshotTable(TABLES.X)`.
 */
export function adminSnapshotTable(tableName: string): Promise<Record<string, any>[]> {
  return adminSnapshot<Record<string, any>[]>(
    `table:${tableName}`,
    () => getAllRecords(tableName) as Promise<Record<string, any>[]>,
  );
}

/** Test hook — clears both memo layers' L1 (Redis is a no-op in tests). */
export function _resetAdminSnapshotForTests(): void {
  _l1.clear();
  _inflight.clear();
}
