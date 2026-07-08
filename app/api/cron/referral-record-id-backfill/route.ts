// app/api/cron/referral-record-id-backfill/route.ts
//
// Self-healing belt for the denormalized rancher-record-id fields on Referrals
// (scale-ladder #1, 2026-07-02). Referral CREATE stamps the id instantly via
// createReferral(); this cron is the catch-all for the paths that don't create
// but re-link — admin reassign, approve, manual edits — plus any create site a
// future dev forgets to route through createReferral. Because it recomputes
// from the link on every row, the text fields CAN'T drift no matter how many
// write paths exist.
//
// Cost: an hourly BACKGROUND full pass (~16 Airtable reads for today's 1.6k
// rows), not a per-request scan — the opposite of the /rancher dashboard
// full-scan this whole fix removes. Only rows whose stored id differs from the
// link get a PATCH (referralRecordIdRepair), so steady-state it writes ~0.

import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { referralRecordIdRepair } from '@/lib/referralRecordId';

export const maxDuration = 120;

interface CronResult {
  status: 'success' | 'partial';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<CronResult> {
  // Scale audit 2026-07-07: the hourly pass now reads only rows MODIFIED in
  // the last 2 hours — drift can only exist on a row something recently
  // touched (re-link, clear, manual edit all bump LAST_MODIFIED_TIME), so
  // this catches every repair case at ~1 request instead of a full-table
  // scan every hour (17 pages and growing 1:1 with buyers). One pass a day
  // (03:xx UTC) still does the unfiltered full sweep as the belt against
  // anything a timestamp can't express. Projected to the four fields the
  // repair decision needs, so payload stays small.
  const fullSweep = new Date().getUTCHours() === 3;
  const windowFormula = "LAST_MODIFIED_TIME() > DATEADD(NOW(), -2, 'hours')";
  let rows: any[] = [];
  try {
    rows = (await getAllRecords(TABLES.REFERRALS, fullSweep ? undefined : windowFormula, {
      fields: ['Rancher', 'Suggested Rancher', 'Rancher Record Id', 'Suggested Rancher Record Id'],
    })) as any[];
  } catch (e: any) {
    return { status: 'partial', recordsTouched: 0, notes: `referrals read failed: ${e?.message?.slice(0, 160) || 'unknown'}` };
  }

  let repaired = 0;
  const errors: string[] = [];
  for (const row of rows) {
    const patch = referralRecordIdRepair(row);
    if (!patch) continue;
    try {
      await updateRecord(TABLES.REFERRALS, row.id, patch);
      repaired++;
      await new Promise((r) => setTimeout(r, 120)); // pace under the 5 req/s base limit
    } catch (e: any) {
      errors.push(`${row.id}: ${e?.message?.slice(0, 60) || 'err'}`);
    }
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: repaired,
    notes: `mode=${fullSweep ? 'full-sweep' : 'modified-2h'} scanned=${rows.length} repaired=${repaired} errs=${errors.length}` + (errors.length ? ` err1=${errors[0]}` : ''),
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('referral-record-id-backfill', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
