// app/api/cron/inbound-body-backfill/route.ts
//
// NIGHTLY SELF-HEAL for blind inbound Conversations rows.
//
// WHY (2026-08-10, recVUDVwrSvVrDZNz post-mortem): the recovery machine
// (lib/inboundBackfill, admin route /api/admin/backfill-inbound-bodies)
// shipped 2026-08-03 as a MANUAL route double-latched behind an arming env
// var — the var was never set in Vercel and the route was never POSTed, so
// 54 blind rows (a rancher's commission-invoice reply among them) sat
// pending for 7 days while Resend's retention window ran down. Same
// pause-asymmetry class as the 2026-07-25 findings: a machine that only a
// human can start never starts.
//
// This cron runs the SAME engine nightly with the standard cron auth and NO
// env latch — self-healing must be default-ON. Spend is bounded: cap per
// night, ~500ms pacing between Resend calls, one classifier call per
// recovered row, one summary operator signal at most. The manual admin route
// (still latched) remains for operator-driven bulk drains.
//
// Boundaries inherited from lib/inboundBackfill (pinned by its tests):
// NO autoresponse, NO staged replies, NO per-row Telegram — recovered rows
// get content + re-classification only.

import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { requireCron } from '@/lib/cronAuth';
import { withCronRun } from '@/lib/cronRun';
import { classifyInboundReply } from '@/lib/inboundClassify';
import { fetchReceivedEmailContent, listReceivedEmails } from '@/lib/inboundContent';
import { runInboundBackfill, BACKFILL_CAP_DEFAULT } from '@/lib/inboundBackfill';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

interface BackfillCronResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<BackfillCronResult> {
  const summary = await runInboundBackfill({
    listRows: async () => {
      // Same server-side narrowing as the admin route: empty Body Plain
      // (pre-fix blind rows) OR fetch-failed marker (webhook fetch failures).
      // isBackfillCandidate re-verifies every row in JS.
      const rows = await getAllRecords(
        TABLES.CONVERSATIONS,
        `AND(LOWER({Direction}) = "inbound", OR({Body Plain} = "", FIND("[content fetch failed", {Body Plain}) = 1))`,
      );
      return rows as any[];
    },
    listReceived: () => listReceivedEmails(),
    fetchContent: (emailId) => fetchReceivedEmailContent(emailId),
    classify: (opts) => classifyInboundReply(opts),
    updateRow: (rowId, fields) => updateRecord(TABLES.CONVERSATIONS, rowId, fields),
    cap: BACKFILL_CAP_DEFAULT,
  });

  // One summary signal per night AT MOST, only when something happened —
  // mirrors the admin route's contract (never per-row).
  if (summary.recovered > 0 || summary.unrecoverable > 0 || !summary.ok) {
    try {
      const { sendOperatorSignal } = await import('@/lib/operatorSignal');
      await sendOperatorSignal({
        urgency: 'normal',
        kind: 'inbound-reply',
        summary: summary.ok
          ? `Nightly inbound body backfill: ${summary.recovered} recovered, ${summary.unrecoverable} unrecoverable, ${summary.remaining} still pending${summary.remaining > 0 ? ' (next night continues)' : ''}.`
          : `Nightly inbound body backfill ABORTED: ${summary.error}`,
        dedupeKey: 'inbound-body-backfill',
        dedupeWindowMs: 60 * 1000,
      });
    } catch {
      /* signal failure must never fail the run */
    }
  }

  if (!summary.ok) {
    return { status: 'error', recordsTouched: 0, notes: summary.error || 'backfill aborted' };
  }
  return {
    status: summary.skippedTransient > 0 || summary.remaining > 0 ? 'partial' : 'success',
    recordsTouched: summary.recovered + summary.unrecoverable,
    notes: `scanned=${summary.scanned} selected=${summary.selected} recovered=${summary.recovered} unrecoverable=${summary.unrecoverable} transient=${summary.skippedTransient} remaining=${summary.remaining}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('inbound-body-backfill', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
