// app/api/cron/log-retention/route.ts
//
// LOG RETENTION (scale audit 2026-07-07, CRITICAL). The base had ZERO
// retention on its append-only log tables — measured ~424 Cron Runs rows/day
// (~12.7k/month) across 49 crons put the base on a collision course with
// Airtable's record cap (~2.2 months to the 50k Team-plan wall at zero
// growth), and every full-scan of those tables got linearly slower forever.
//
// ── CAPACITY AUDIT 2026-08-19: THE DRAIN COULD NOT OUT-PACE INFLOW ──────────
// Retention WAS running (33.7 days of Cron Runs history proves deletion
// works), but it was structurally incapable of getting ahead:
//   • MAX_DELETES_PER_TABLE = 1,000 per table per run, on a ONCE-DAILY cron.
//     Above ~1,000 rows/day on any single table the deficit compounds forever.
//   • Worse, there was no capacity to work down a BACKLOG. Shortening any
//     window creates a one-time backlog that would then drain at 1,000/day —
//     an ~18,000-row Email Sends backlog would take 18 DAYS while the base sat
//     against its cap.
// Replaced with a TIME-BUDGETED drain (lib/logRetentionPlan.ts): each run
// spends up to RUN_BUDGET_MS deleting, shared fairly across tables, paced at
// 2.5 req/s (HALF Airtable's 5 req/s ceiling — the old 250ms pacing was 4
// req/s, i.e. the cron that exists to protect the base was itself consuming
// 80% of its request budget). Measured capacity ~24,000 rows/day against ~795
// rows/day of measured inflow, and it can clear a five-figure backlog in a
// single run. Schedule moved from `10 9 * * *` to `10 3,9,15,21 * * *`.
//
// Windows, the reasoning behind each one, and which are the OPERATOR's call
// rather than ours, all live in lib/logRetentionPlan.ts's RETENTION table.
// Short version: Email Sends at 90 days converges to ~35,900 rows — 72% of the
// entire base cap on its own — and must come down, but it is NOT a pure log
// table (send-scheduled and testimonial-collection use it as an unbounded
// send-dedupe ledger), so shortening it is Ben's call. He can make it without
// a deploy via LOG_RETENTION_DAYS_OVERRIDE, and this drain will clear the
// resulting backlog the same day.
//
// DARK BY DEFAULT — env LOG_RETENTION_ENABLED, platform 3-state contract:
//   unset/other → skipped BEFORE withCronRun (no Cron Runs row while dark)
//   'dry-run'   → counts + Telegram report, deletes NOTHING
//   'true'      → deletes, time-budgeted + paced under the 5 req/s ceiling
//
// Never touches entity tables (Consumers/Referrals/Ranchers/Payments/Orders):
// the RETENTION list is compiled in, and an env override naming a table that
// is not already on it is IGNORED.

import { NextResponse } from 'next/server';
import { getAllRecords, deleteRecordsBatch } from '@/lib/airtable';
import { runAirtableBackup } from '@/lib/airtableBackup';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { shouldSendCronReport } from '@/lib/cronReportGate';
import {
  RETENTION,
  RUN_BUDGET_MS,
  DELETE_BATCH_SIZE,
  MAX_DELETES_PER_TABLE_PER_RUN,
  applyRetentionOverrides,
  parseRetentionOverrides,
  perTableBudgetMs,
  resolveBatchPacingMs,
  rowsAffordable,
  isCensusOrBackupRun,
} from '@/lib/logRetentionPlan';

export const maxDuration = 300;

interface CronResult {
  status: 'success' | 'partial';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<CronResult> {
  const dryRun = process.env.LOG_RETENTION_ENABLED === 'dry-run';
  const pacingMs = resolveBatchPacingMs();
  const rules = applyRetentionOverrides(
    RETENTION,
    parseRetentionOverrides(process.env.LOG_RETENTION_DAYS_OVERRIDE),
  );

  let totalDeleted = 0;
  const lines: string[] = [];
  const errors: string[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < rules.length; i++) {
    const { table, days } = rules[i];

    // Fair share of what's LEFT, recomputed per table: a table that drains
    // early hands its leftover to the ones behind it, and no single huge table
    // can consume the whole run and starve the rest.
    const remainingMs = RUN_BUDGET_MS - (Date.now() - startedAt);
    const budgetMs = perTableBudgetMs(remainingMs, rules.length - i);
    const affordable = Math.min(
      rowsAffordable(budgetMs, pacingMs, DELETE_BATCH_SIZE),
      MAX_DELETES_PER_TABLE_PER_RUN,
    );
    if (affordable <= 0 && !dryRun) {
      lines.push(`${table}: skipped (run budget spent)`);
      continue;
    }

    // maxRecords caps the READ too: we only ever act on the first `affordable`
    // rows, so walking a 10k-row backlog just to slice it is pure request
    // waste. +1 so the report can say "backlog remains" vs "fully drained".
    const readCap = (dryRun ? MAX_DELETES_PER_TABLE_PER_RUN : affordable) + 1;
    let old: any[] = [];
    try {
      old = (await getAllRecords(
        table,
        `IS_BEFORE(CREATED_TIME(), DATEADD(NOW(), -${days}, 'days'))`,
        { maxRecords: readCap },
      )) as any[];
    } catch (e: any) {
      errors.push(`${table}: read failed ${e?.message?.slice(0, 60) || 'err'}`);
      continue;
    }

    const backlogLabel = old.length >= readCap ? `${readCap - 1}+` : String(old.length);
    if (dryRun) {
      lines.push(`${table}: ${backlogLabel} rows past ${days}d (would delete ${Math.min(old.length, affordable)} this run)`);
      continue;
    }

    const batchIds = old.slice(0, affordable).map((r: any) => r.id);
    let deleted = 0;
    for (let j = 0; j < batchIds.length; j += DELETE_BATCH_SIZE) {
      // Hard stop on the wall clock as well as the row count — a slow Airtable
      // must not push this run past maxDuration and lose the backup leg.
      if (Date.now() - startedAt >= RUN_BUDGET_MS) {
        lines.push(`${table}: stopped at ${deleted} (run budget spent)`);
        break;
      }
      const chunk = batchIds.slice(j, j + DELETE_BATCH_SIZE);
      try {
        const res = await deleteRecordsBatch(table, chunk);
        deleted += res.length;
      } catch (e: any) {
        errors.push(`${table}: batch delete failed at ${deleted} — ${e?.message?.slice(0, 50) || 'err'}`);
        break; // a delete failure mid-table → stop this table, keep others
      }
      await new Promise((r) => setTimeout(r, pacingMs)); // <=2.5 req/s
    }
    totalDeleted += deleted;
    lines.push(`${table}: deleted ${deleted}/${backlogLabel} past ${days}d`);
  }

  // Wave 1C (2026-08-01): was urgency 'digest', which suppress-and-logs (no
  // digest collector exists) — this report NEVER reached the operator; the
  // Cron Runs note was the only record. Now: realtime 'normal' card only when
  // the run actually pruned something or errored (shouldSendCronReport);
  // zero-work runs stay in the Cron Runs row alone. Dry-run counts land in
  // the notes below — no realtime ping for a plan that won't execute.
  if (!dryRun && shouldSendCronReport({ workDone: totalDeleted, failures: errors.length })) {
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'audit',
      summary: `log-retention: pruned ${totalDeleted} rows`,
      detail: lines.join('\n') + (errors.length ? `\nerrors: ${errors.slice(0, 3).join(' | ')}` : ''),
      dedupeKey: `log-retention:${new Date().toISOString().slice(0, 10)}`,
    }).catch(() => {});
  } else {
    console.info(`[log-retention] ${dryRun ? 'DRY RUN — ' : ''}${lines.join(' · ') || 'nothing to prune'} (no realtime report)`);
  }

  // ── NIGHTLY ENTITY BACKUP LEG (2026-08-02, blindspot fix) ─────────────────
  // Rides this cron by design ("no more crons"): the base had ZERO backups.
  // Encrypted entity export → Vercel Blob, newest 14 kept. Runs in BOTH live
  // and dry-run retention modes (it's read-only against Airtable, and a
  // dry-run of DELETES must never also dry-run the BACKUP). A failed backup
  // flips the run to 'partial' so the missing-backup state is visible in the
  // dead-man/watchdog chain without its own alert channel. Full design +
  // restore procedure: lib/airtableBackup.ts header.
  //
  // ONCE A DAY, not once a run (2026-08-19): this cron now fires 4x/day, and
  // the backup keeps only the newest 14 blobs — backing up every run would
  // silently cut backup history from 14 days to 3.5.
  let backupNote = 'backup: skipped (not the daily slot)';
  let backupOk = true;
  if (isCensusOrBackupRun()) {
    const backup = await runAirtableBackup(Date.now());
    backupOk = backup.ok;
    backupNote = backup.ok
      ? `backup: ${backup.rows} rows/${backup.tables} tables → ${backup.blobPathname}${backup.pruned ? ` (pruned ${backup.pruned})` : ''}`
      : `backup FAILED: ${backup.error}`;
  }

  return {
    status: errors.length || !backupOk ? 'partial' : 'success',
    recordsTouched: totalDeleted,
    notes: `${dryRun ? 'DRY-RUN ' : ''}${lines.join(' · ')}${errors.length ? ` errs=${errors.length}` : ''} · ${backupNote}`.slice(0, 500),
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
