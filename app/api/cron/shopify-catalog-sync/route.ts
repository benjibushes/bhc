// SHOPIFY CATALOG SYNC — keeps sync-mode ranchers' Rancher Products rows
// matching their store (price, inventory, active status, images) so /shop
// never sells what they can't fulfill and never underprices a raise.
// Per-product PRODUCTS_UPDATE webhooks give near-real-time freshness; this
// cron is the drift net (webhook misses, inventory changes from orders
// placed directly on their store, first-run backfills).

import { getAllRecords, TABLES } from '@/lib/airtable';
import { parseIntegration } from '@/lib/fulfillmentConnector';
import { syncShopifyCatalog } from '@/lib/shopifyCatalogSync';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { isMaintenanceMode } from '@/lib/maintenance';

export const maxDuration = 300;

interface SyncCronResult {
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<SyncCronResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  let ranchers: any[];
  try {
    ranchers = (await getAllRecords(
      TABLES.RANCHERS,
      `FIND('"mode":"sync"', {Fulfillment Integration})`,
    )) as any[];
  } catch (e: any) {
    return { status: 'partial', recordsTouched: 0, notes: `rancher query failed: ${String(e?.message || '').slice(0, 150)}` };
  }
  const targets = ranchers.filter((r) => parseIntegration(r['Fulfillment Integration'])?.mode === 'sync');

  let touched = 0;
  const notes: string[] = [];
  for (const r of targets) {
    try {
      const res = await syncShopifyCatalog(String(r.id));
      touched += res.imported + res.updated;
      notes.push(`${String(r['Ranch Name'] || r.id)}: ${res.report.join('; ')}`);
    } catch (e: any) {
      notes.push(`${String(r['Ranch Name'] || r.id)}: ERROR ${String(e?.message || '').slice(0, 100)}`);
    }
  }

  return {
    status: notes.some((n) => n.includes('ERROR') || n.includes('failed')) ? 'partial' : 'success',
    recordsTouched: touched,
    notes: notes.join(' | ') || 'no sync-mode ranchers',
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('shopify-catalog-sync', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
