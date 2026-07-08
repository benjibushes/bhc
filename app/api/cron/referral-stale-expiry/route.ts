// app/api/cron/referral-stale-expiry/route.ts
//
// STALE-HOLD EXPIRY (routing sweep 2026-07-08) — daily, 13:10 UTC, deliberately
// BEFORE stuck-buyer-recovery (14:30): slots freed here get routed to READY
// buyers the same morning.
//
// WHY: capacity slots are held from Intro Sent → Closed Won/Lost with no
// expiry. Discovery data: Silverline 60 holds vs cap 50, Foodstead 59/50 —
// FULL to the matcher on dead intros while fresh qualified buyers in their
// states sat READY. Founder rule: ranchers receive leads until they actually
// SELL their capacity — dead intros must drain back into the pool.
//
// WHAT IT DOES: selects referrals via lib/staleHolds (Intro Sent / Rancher
// Contacted · zero deposit signals · silent >21 days on BOTH sides) and flips
// them to Status='Dormant'. Buyer stays re-marketable (demandRouter treats
// Dormant as not-in-deal); the stored Current Active Referrals counter
// self-heals from truth within ~2h (batch-approve recompute); NO buyer or
// rancher email fires — this is silent bookkeeping, not a breakup note.
//
// DARK (platform contract): STALE_HOLD_EXPIRY_ENABLED unset → skip before any
// read · 'dry-run' → full per-rancher freed report to Telegram, writes
// NOTHING · 'true' → expire + report. Cap 50 flips/run (rate-limit sanity;
// backlog drains over a few mornings).

import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { selectStaleHolds, freedByRancher, DEFAULT_STALE_DAYS } from '@/lib/staleHolds';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const RUN_CAP = 50;

interface ExpiryResult {
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}

async function realHandler(_request: Request): Promise<ExpiryResult> {
  const mode = process.env.STALE_HOLD_EXPIRY_ENABLED;
  if (mode !== 'true' && mode !== 'dry-run') {
    return {
      status: 'success',
      recordsTouched: 0,
      notes: 'skipped: STALE_HOLD_EXPIRY_ENABLED not set',
      skipReasonBreakdown: { disabled: 1 },
    };
  }
  if (await isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'maintenance mode' };
  }
  const dryRun = mode === 'dry-run';
  const staleDays = Number(process.env.STALE_HOLD_DAYS) || DEFAULT_STALE_DAYS;

  // Only the two expirable statuses leave Airtable — the selector re-checks
  // every guard in JS (belt); the formula just keeps the read small.
  const rows = (await getAllRecords(
    TABLES.REFERRALS,
    `OR({Status} = "Intro Sent", {Status} = "Rancher Contacted")`,
  )) as any[];

  const stale = selectStaleHolds(rows, Date.now(), { staleDays, cap: RUN_CAP });
  if (stale.length === 0) {
    return { status: 'success', recordsTouched: 0, notes: `no stale holds (${rows.length} open intros scanned)` };
  }

  const perRancher = freedByRancher(stale);
  const rancherNames: Record<string, string> = {};
  try {
    const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
    for (const r of ranchers) rancherNames[r.id] = String(r['Ranch Name'] || r.id);
  } catch {
    /* report falls back to record ids */
  }
  const reportLines = Object.entries(perRancher)
    .sort((a, b) => b[1] - a[1])
    .map(([rid, n]) => `· ${rancherNames[rid] || rid}: ${n} slot${n === 1 ? '' : 's'} freed`);

  if (dryRun) {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🧪 <b>stale-hold expiry DRY RUN</b> — nothing written\n\n` +
        `would free <b>${stale.length}</b> capacity slot${stale.length === 1 ? '' : 's'} ` +
        `(intros silent &gt;${staleDays}d, zero deposit signals):\n${reportLines.join('\n')}\n\n` +
        `flip STALE_HOLD_EXPIRY_ENABLED=true to run it. counters self-heal ≤2h; ` +
        `stuck-buyer-recovery routes freed slots at 14:30 UTC.`,
    ).catch(() => {});
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `dry-run: would expire ${stale.length}`,
      skipReasonBreakdown: { 'dry-run-would-expire': stale.length },
    };
  }

  let expired = 0;
  let failed = 0;
  for (const ref of stale) {
    try {
      await updateRecord(TABLES.REFERRALS, ref.id, { Status: 'Dormant' });
      expired++;
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  await sendTelegramMessage(
    TELEGRAM_ADMIN_CHAT_ID,
    `🧹 <b>stale-hold expiry</b> — freed <b>${expired}</b> capacity slot${expired === 1 ? '' : 's'}` +
      (failed ? ` (${failed} failed, retried tomorrow)` : '') +
      `\n\n${reportLines.join('\n')}\n\n` +
      `buyers stay re-marketable · counters self-heal ≤2h · recovery cron routes the freed slots at 14:30 UTC.`,
  ).catch(() => {});

  return {
    status: failed ? 'partial' : 'success',
    recordsTouched: expired,
    notes: `expired ${expired}${failed ? `, ${failed} failed` : ''} of ${stale.length} selected`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('referral-stale-expiry', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
