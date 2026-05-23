import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { classifyBuyer, type RoutingSegment } from '@/lib/routingSegment';
import { withCronRun } from '@/lib/cronRun';
import { CRON_SECRET } from '@/lib/secrets';

// Reclassify-buyers cron.
//
// Every night, reads every Consumer + every Rancher, computes the buyer's
// current Routing Segment based on state coverage + intent signals + profile
// completeness, and writes it back. Downstream email-sequences cron branches
// on this field to decide what email to send.
//
// Why nightly:
//   Rancher capacity and roster change daily. A buyer who was
//   OUT_OF_STATE_FOUNDER_PITCH yesterday becomes NUDGE_TO_ENGAGE the moment
//   a rancher goes live in their state. Same buyer becomes MATCH_NOW the
//   moment they click "Ready to Buy." Recomputing every 24h keeps segments
//   honest without driving the rate limiter into the floor at 30k+ writes.
//
// Idempotency:
//   Only writes when the computed segment differs from the stored one.
//   Steady-state run touches a handful of records per night.
//
// Schedule: daily 04:00 UTC (10pm MT prev day) — runs after every other
// email cron has finished its 24h cycle, so tomorrow morning's email crons
// start with fresh segments.

export const maxDuration = 300;

async function realHandler(
  _request: Request,
): Promise<{
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
}> {
  if (isMaintenanceMode()) {
    return {
      status: 'maintenance-blocked',
      recordsTouched: 0,
      notes: 'MAINTENANCE_MODE=true',
    };
  }

  const [consumers, ranchers] = await Promise.all([
    getAllRecords(TABLES.CONSUMERS) as Promise<any[]>,
    getAllRecords(TABLES.RANCHERS) as Promise<any[]>,
  ]);

  const counts: Record<string, number> = {};
  const updates: Array<{ id: string; segment: RoutingSegment; old: string }> = [];

  for (const buyer of consumers) {
    const segment = classifyBuyer(buyer, ranchers);
    counts[segment] = (counts[segment] || 0) + 1;
    const current = buyer['Routing Segment'] || '';
    const currentName =
      typeof current === 'object' && current !== null && 'name' in current
        ? String((current as any).name || '')
        : String(current || '');
    if (currentName !== segment) {
      updates.push({ id: buyer.id, segment, old: currentName });
    }
  }

  let updated = 0;
  let errored = 0;
  for (const u of updates) {
    try {
      await updateRecord(TABLES.CONSUMERS, u.id, { 'Routing Segment': u.segment });
      updated++;
    } catch (e: any) {
      errored++;
      console.warn(`[reclassify-buyers] update failed for ${u.id}:`, e?.message);
    }
  }

  const breakdown = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');

  return {
    status: errored > 0 ? 'partial' : 'success',
    recordsTouched: updated,
    notes: `total=${consumers.length} changed=${updates.length} updated=${updated} errors=${errored} | ${breakdown}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  if (CRON_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      const { searchParams } = new URL(request.url);
      if (searchParams.get('secret') !== CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('reclassify-buyers', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
