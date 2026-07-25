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
import { getOperationalServedStates } from '@/lib/rancherEligibility';
import { cacheGet, cacheSet } from '@/lib/sharedCache';
import type { StuckRancherRow } from '@/lib/stuckRancherQueue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Waiting-buyer demand moves slowly; six refreshes an hour is plenty. */
const DEMAND_CACHE_KEY = 'admin:stuck-ranchers:waiting-demand-by-state';
const DEMAND_CACHE_TTL_MS = 10 * 60 * 1000;

type DemandMap = Record<string, number>;

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

/** Flatten one Airtable rancher onto the pure scorer's input shape. */
function toStuckRow(record: any, demand: DemandMap): StuckRancherRow {
  // Routing precedence (home state, plus admin-approved multi-state) — the same
  // helper the match engine uses, so "buyers waiting" means the buyers this
  // rancher would actually be routed.
  const servedStates = getOperationalServedStates(record);
  const buyersWaiting = servedStates.reduce((sum, st) => sum + (demand[st] || 0), 0);

  const readEnum = (v: unknown): string => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && v !== null && 'name' in v) {
      return String((v as { name?: unknown }).name || '');
    }
    return String(v);
  };

  return {
    id: record.id,
    ranchName: String(record['Ranch Name'] || ''),
    operatorName: String(record['Operator Name'] || ''),
    state: String(record['State'] || '').trim().toUpperCase(),
    email: String(record['Email'] || '').trim(),
    phone: String(record['Phone'] || '').trim(),
    emailOptOut: !!record['Unsubscribed'] || !!record['Bounced'],
    activeStatus: readEnum(record['Active Status']),
    verificationStatus: readEnum(record['Verification Status']),
    onboardingStatus: readEnum(record['Onboarding Status']),
    agreementSigned: !!record['Agreement Signed'],
    pageLive: !!record['Page Live'],
    pricingModel: String(record['Pricing Model'] || ''),
    connectAccountId: String(record['Stripe Connect Account Id'] || ''),
    connectStatus: String(record['Stripe Connect Status'] || ''),
    hasSlug: !!record['Slug'],
    maxPrice: Math.max(
      0,
      Number(record['Quarter Price']) || 0,
      Number(record['Half Price']) || 0,
      Number(record['Whole Price']) || 0,
    ),
    hasPaymentLink: !!(
      record['Quarter Payment Link'] ||
      record['Half Payment Link'] ||
      record['Whole Payment Link']
    ),
    stuckEscalatedAt: String(record['Stuck Escalated At'] || ''),
    stuckEscalatedBucket: String(record['Stuck Escalated Bucket'] || ''),
    lastTouchAt: String(record['Last Touch At'] || ''),
    buyersWaiting,
    servedStates,
  };
}

export async function GET(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  try {
    const [ranchers, demandResult] = await Promise.all([
      getAllRecords(TABLES.RANCHERS) as Promise<any[]>,
      waitingDemandByState(),
    ]);

    const { demand, cached } = demandResult;
    const rows = (ranchers || [])
      .filter((r: any) => !!r['Stuck Escalated At'])
      .map((r: any) => toStuckRow(r, demand));

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
