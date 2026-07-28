// app/api/cron/log-retention/route.ts
//
// LOG RETENTION (scale audit 2026-07-07, CRITICAL). The base had ZERO
// retention on its append-only log tables — measured ~424 Cron Runs rows/day
// (~12.7k/month) across 49 crons put the base on a collision course with
// Airtable's record cap (~2.2 months to the 50k Team-plan wall at zero
// growth), and every full-scan of those tables got linearly slower forever.
//
// Windows (config below): operational logs keep enough history for debugging
// + the watchdog/monthly reports, then rows age out:
//   Cron Runs     30d  (watchdog looks at 24h; monthly report at 30d)
//   Email Sends   90d  (engagement metrics read 30d; keep a quarter)
//   Funnel Events 90d  (funnel uses the state-snapshot model; events = audit)
//   Stripe Events 60d  (webhook dedup ledger; Stripe redelivers ≤3 days)
//
// DARK BY DEFAULT — env LOG_RETENTION_ENABLED, platform 3-state contract:
//   unset/other → skipped BEFORE withCronRun (no Cron Runs row while dark)
//   'dry-run'   → counts + Telegram report, deletes NOTHING
//   'true'      → deletes, capped + paced under the 5 req/s ceiling
//
// Deletes are capped per table per run (the backlog drains over days, the
// cron never monopolizes the rate budget), batched 10-per-request, and paced
// so the request rate stays under the 5 req/s ceiling. Never touches entity
// tables (Consumers/Referrals/Ranchers/Payments/Orders).

import { NextResponse } from 'next/server';
import { getAllRecords, deleteRecordsBatch, TABLES } from '@/lib/airtable';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { sendOperatorSignal } from '@/lib/operatorSignal';

export const maxDuration = 300;

const RETENTION: { table: string; days: number }[] = [
  { table: TABLES.CRON_RUNS, days: 30 },
  { table: TABLES.EMAIL_SENDS, days: 90 },
  { table: 'Funnel Events', days: 90 },
  { table: 'Stripe Events', days: 60 },
];

// Capacity audit 2026-07-28. Deletes now go 10-per-request (Airtable's batch
// DELETE limit, via deleteRecordsBatch) — the old one-per-request loop paced
// at 150ms was 6.7 req/s, OVER the 5 req/s base ceiling this cron exists to
// protect. New shape: one 10-row request every BATCH_PACING_MS = ≤4 req/s.
//
// Per-table per-run cap raised 300 → 1,000: measured inflow is ~424 Cron Runs
// rows/day (~600/day across all log tables), so the old cap barely broke even
// and the backlog never drained. 1,000 = 100 requests ≈ 25s per table at this
// pacing; 4 tables worst-case ≈ 100s + reads, comfortably inside maxDuration.
const MAX_DELETES_PER_TABLE = 1000;
const DELETE_BATCH_SIZE = 10;
const BATCH_PACING_MS = 250;

interface CronResult {
  status: 'success' | 'partial';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<CronResult> {
  const dryRun = process.env.LOG_RETENTION_ENABLED === 'dry-run';
  let totalDeleted = 0;
  const lines: string[] = [];
  const errors: string[] = [];

  for (const { table, days } of RETENTION) {
    let old: any[] = [];
    try {
      // maxRecords caps the READ too: we only ever act on the first
      // MAX_DELETES_PER_TABLE rows, so walking a 10k-row backlog (100+
      // paginated requests) just to slice it was pure request waste. +1 so
      // the report can still say "backlog remains" vs "fully drained".
      old = (await getAllRecords(
        table,
        `IS_BEFORE(CREATED_TIME(), DATEADD(NOW(), -${days}, 'days'))`,
        { maxRecords: MAX_DELETES_PER_TABLE + 1 },
      )) as any[];
    } catch (e: any) {
      errors.push(`${table}: read failed ${e?.message?.slice(0, 60) || 'err'}`);
      continue;
    }

    const backlogLabel = old.length > MAX_DELETES_PER_TABLE ? `${MAX_DELETES_PER_TABLE}+` : String(old.length);
    const batchIds = old.slice(0, MAX_DELETES_PER_TABLE).map((r: any) => r.id);
    if (dryRun) {
      lines.push(`${table}: ${backlogLabel} rows past ${days}d (would delete ${batchIds.length} this run)`);
      continue;
    }

    let deleted = 0;
    for (let i = 0; i < batchIds.length; i += DELETE_BATCH_SIZE) {
      const chunk = batchIds.slice(i, i + DELETE_BATCH_SIZE);
      try {
        const res = await deleteRecordsBatch(table, chunk);
        deleted += res.length;
      } catch (e: any) {
        errors.push(`${table}: batch delete failed at ${deleted} — ${e?.message?.slice(0, 50) || 'err'}`);
        break; // a delete failure mid-table → stop this table, keep others
      }
      await new Promise((r) => setTimeout(r, BATCH_PACING_MS)); // ≤4 req/s
    }
    totalDeleted += deleted;
    lines.push(`${table}: deleted ${deleted}/${backlogLabel} past ${days}d`);
  }

  // Report in BOTH modes — dry-run is exactly the eyeball step before the
  // env flips true, and live runs stay visible until the backlog drains.
  await sendOperatorSignal({
    urgency: 'digest',
    kind: 'audit',
    summary: dryRun
      ? 'log-retention DRY RUN — nothing deleted'
      : `log-retention: pruned ${totalDeleted} rows`,
    detail: lines.join('\n') + (errors.length ? `\nerrors: ${errors.slice(0, 3).join(' | ')}` : ''),
    dedupeKey: `log-retention:${new Date().toISOString().slice(0, 10)}`,
  }).catch(() => {});

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: totalDeleted,
    notes: `${dryRun ? 'DRY-RUN ' : ''}${lines.join(' · ')}${errors.length ? ` errs=${errors.length}` : ''}`.slice(0, 500),
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;

  const mode = process.env.LOG_RETENTION_ENABLED;
  if (mode !== 'true' && mode !== 'dry-run') {
    return NextResponse.json({ skipped: 'disabled' });
  }

  return withCronRun('log-retention', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
