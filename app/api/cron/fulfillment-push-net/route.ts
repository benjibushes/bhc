// FULFILLMENT PUSH SAFETY NET — retries connector pushes the settle-time
// side effect missed (docs/plans/2026-07-21-shopify-fulfillment-connector.md,
// Task 6).
//
// Failure class it closes: the inline push in settleProductPurchase is
// best-effort — a Shopify throttle/5xx/network blip at settle time leaves
// 'External Push Status' BLANK, and without this sweep the paid order would
// simply never appear in the rancher's store (they'd ship nothing). Also
// picks up orders settled BEFORE the rancher connected their store (3-day
// window) — connect on Tuesday, Monday's paid orders still push.
//
// Idempotent: runFulfillmentPush re-checks the gate (already-pushed /
// terminal-skip stamps) every attempt, and push success stamps
// 'External Order Id', so a webhook-vs-cron race can't double-create.
//
// Schedule: every 2h (vercel.json). Cap 20/run — connector calls are
// serial Shopify API hits.

import { getAllRecords, getRecordById, TABLES } from '@/lib/airtable';
import { runFulfillmentPush } from '@/lib/fulfillmentPushRunner';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { isMaintenanceMode } from '@/lib/maintenance';

export const maxDuration = 120;

const WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 20;

interface NetResult {
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}

async function realHandler(_request: Request): Promise<NetResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  let candidates: any[];
  try {
    candidates = (await getAllRecords(
      TABLES.RANCHER_ORDERS,
      `AND({Status} = "New", {External Push Status} = "", IS_AFTER({Ordered At}, "${cutoff}"))`,
    )) as any[];
  } catch (e: any) {
    return { status: 'partial', recordsTouched: 0, notes: `query failed: ${String(e?.message || 'unknown').slice(0, 200)}` };
  }

  let pushed = 0;
  const breakdown: Record<string, number> = {};
  for (const row of candidates.slice(0, MAX_PER_RUN)) {
    await runFulfillmentPush(String(row.id));
    const after = await getRecordById(TABLES.RANCHER_ORDERS, String(row.id)).catch(() => null);
    const status = String(after?.['External Push Status'] || '').trim();
    if (status === 'pushed') pushed++;
    const key = status ? status.split(':')[0] : 'unstamped';
    breakdown[key] = (breakdown[key] || 0) + 1;
  }

  return {
    status: 'success',
    recordsTouched: pushed,
    notes: `${candidates.length} candidates (cap ${MAX_PER_RUN}), ${pushed} pushed`,
    skipReasonBreakdown: breakdown,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('fulfillment-push-net', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
