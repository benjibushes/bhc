// GET /api/admin/stuck-ranchers — the list behind the desk's Stuck Ranchers queue.
//
// `Stuck Escalated At` is stamped by two crons that then go permanently silent
// by design (app/api/cron/onboarding-stuck + app/api/cron/rancher-followup: one
// Telegram ping, never repeated). Nothing has ever READ that field: 61 of 87
// ranchers carry the stamp and not one has been worked. This endpoint is that
// read.
//
// STRICTLY READ-ONLY. No writes, no email, no Telegram. It only selects.
//
// Airtable budget (the base is capped at 5 req/s):
//   • Ranchers — one full list, served by the two-layer cache in lib/airtable
//     (L1 in-process 10s + L2 shared Redis), so a desk reload almost never
//     reaches Airtable. 87 records = 1 request on a cold miss.
//   • Consumers — one WAITING-only, State-projected scan behind its own 10-min
//     shared-cache entry, so the ~21-page walk happens at most six times an
//     hour across the whole fleet no matter how often the desk is reloaded.
//     Fail-open: a Redis miss just re-reads Airtable.
// Nothing here is per-row. Adding a rancher costs zero extra reads.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { excludeBrokerRanchers } from '@/lib/brokerRail';
import { cacheGet, cacheSet } from '@/lib/sharedCache';
import {
  toStuckRancherRow,
  type DemandMap,
} from '@/lib/stuckRancherAirtable';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Waiting-buyer demand moves slowly; six refreshes an hour is plenty. */
const DEMAND_CACHE_KEY = 'admin:stuck-ranchers:waiting-demand-by-state';
const DEMAND_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * WAITING buyers per state — the buyers with NO rancher able to serve them.
 * Same cohort definition as /api/admin/demand-heatmap, so the two boards agree.
 */
async function waitingDemandByState(): Promise<{ demand: DemandMap; cached: boolean }> {
  const hit = await cacheGet<DemandMap>(DEMAND_CACHE_KEY);
  if (hit && typeof hit === 'object') return { demand: hit, cached: true };

  const waiting = (await getAllRecords(
    TABLES.CONSUMERS,
    `AND({Buyer Stage}="WAITING", NOT({Email}=""), {Unsubscribed}!=1)`,
    { fields: ['State'] },
  ).catch(() => [] as any[])) as any[];

  const demand: DemandMap = {};
  for (const c of waiting) {
    const st = String(c['State'] || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(st)) continue;
    demand[st] = (demand[st] || 0) + 1;
  }
  // Never cache the empty map — a degraded read must not pin every rancher's
  // demand to zero for ten minutes.
  if (Object.keys(demand).length > 0) {
    await cacheSet(DEMAND_CACHE_KEY, demand, DEMAND_CACHE_TTL_MS);
  }
  return { demand, cached: false };
}

// Row shaping lives in lib/stuckRancherAirtable (extracted Wave 1B) so the
// /admin/today cockpit flattens ranchers identically to this endpoint.

export async function GET(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  try {
    const [ranchers, demandResult] = await Promise.all([
      getAllRecords(TABLES.RANCHERS) as Promise<any[]>,
      waitingDemandByState(),
    ]);

    const { demand, cached } = demandResult;
    // BROKER RAIL: a represented rancher is never "stuck" — having no Connect
    // account and no live page is their designed end state, not a blocked
    // onboarding. Keep them out of the operator's call queue.
    const rows = excludeBrokerRanchers(ranchers || [])
      .filter((r: any) => !!r['Stuck Escalated At'])
      .map((r: any) => toStuckRancherRow(r, demand));

    return NextResponse.json({
      rows,
      totalRanchers: (ranchers || []).length,
      totalWaitingBuyers: Object.values(demand).reduce((a, b) => a + b, 0),
      demandFromCache: cached,
      generatedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('[admin/stuck-ranchers] failed:', e?.message);
    return NextResponse.json({ error: 'Failed to load stuck ranchers' }, { status: 500 });
  }
}
