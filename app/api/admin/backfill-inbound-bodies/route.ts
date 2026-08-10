// POST /api/admin/backfill-inbound-bodies — recover the blind inbound rows.
//
// Every real email reply captured before the content-fetch fix landed in
// Conversations as an ENVELOPE-ONLY row (From/Subject/Timestamp set; Body +
// Body Plain empty; Raw Headers '{}'; Message Id never written). This route
// walks those rows, matches each against Resend's received-emails listing
// (bare From + timestamp proximity — no Resend id was stored, so there is
// nothing to fetch by directly), pulls the stored content by the matched id,
// writes Body / Body Plain / Raw Headers / Message Id, and re-runs the
// CLASSIFIER ONLY (Sender Type / Objection Category / Sentiment / Action
// Needed / AI Summary — the exact same lib/inboundClassify brain as the live
// webhook).
//
// OPERATOR CONTRACT (pinned by lib/inboundBackfill.test.ts):
//   - INERT until the operator POSTs — and DOUBLE-LATCHED: requires admin
//     auth AND INBOUND_BACKFILL_ENABLED=1 in the environment.
//   - NO autoresponse, NO staged-reply sending, NO per-row Telegram. One
//     summary operator signal at the end of a non-dry run.
//   - Idempotent: rows with non-empty Body Plain are never touched.
//   - Cap 50 rows per invocation, ~500ms pace between Resend fetches —
//     re-POST until `remaining` hits 0.
//   - Unmatched / no-longer-retained rows get the '[content unrecoverable]'
//     marker so they stop looking pending. Transient fetch failures leave
//     the row untouched for the next run.
//
// Body (JSON, optional): { "dryRun": true } — match + count only, zero
// writes, zero classifier spend, zero signals.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { classifyInboundReply } from '@/lib/inboundClassify';
import { fetchReceivedEmailContent, listReceivedEmails } from '@/lib/inboundContent';
import { runInboundBackfill, BACKFILL_CAP_DEFAULT } from '@/lib/inboundBackfill';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const GATE_ENV = 'INBOUND_BACKFILL_ENABLED';

function gateClosed(): NextResponse | null {
  if (process.env[GATE_ENV] === '1') return null;
  return NextResponse.json(
    {
      ok: false,
      error: `backfill disabled — set ${GATE_ENV}=1 to arm this route`,
    },
    { status: 403 },
  );
}

export async function POST(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;
  const closed = gateClosed();
  if (closed) return closed;

  let dryRun = false;
  try {
    const body = await request.json();
    dryRun = body?.dryRun === true;
  } catch {
    /* empty body → full run */
  }

  const summary = await runInboundBackfill({
    listRows: async () => {
      // Formula narrows server-side; isBackfillCandidate re-verifies in JS
      // (case-insensitive Direction, ig:-prefixed DM rows, @-less From).
      // Covers BOTH pending classes: empty Body Plain (pre-fix blind rows)
      // and fetch-failed marker rows (2026-08-10 — previously untouchable).
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
    dryRun,
  });

  // ONE summary signal per real run — never per-row, never on dry runs.
  if (!dryRun && (summary.recovered > 0 || summary.unrecoverable > 0 || !summary.ok)) {
    try {
      const { sendOperatorSignal } = await import('@/lib/operatorSignal');
      await sendOperatorSignal({
        urgency: 'normal',
        kind: 'inbound-reply',
        summary: summary.ok
          ? `Inbound body backfill: ${summary.recovered} recovered, ${summary.unrecoverable} unrecoverable, ${summary.remaining} still pending${summary.remaining > 0 ? ' — POST again to continue' : ''}.`
          : `Inbound body backfill ABORTED: ${summary.error}`,
        dedupeKey: 'inbound-body-backfill',
        dedupeWindowMs: 60 * 1000,
      });
    } catch {
      /* signal failure must never fail the run report */
    }
  }

  return NextResponse.json(summary, { status: summary.ok ? 200 : 502 });
}

// GET — status probe: is the gate armed, and how many rows still look blind?
// Read-only, admin-authed, no Resend traffic.
export async function GET(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;
  let pending: number | null = null;
  try {
    const rows = (await getAllRecords(
      TABLES.CONVERSATIONS,
      `AND(LOWER({Direction}) = "inbound", OR({Body Plain} = "", FIND("[content fetch failed", {Body Plain}) = 1))`,
    )) as any[];
    const { isBackfillCandidate } = await import('@/lib/inboundBackfill');
    pending = rows.filter(isBackfillCandidate).length;
  } catch {
    /* pending stays null — probe is best-effort */
  }
  return NextResponse.json({
    ok: true,
    endpoint: 'backfill-inbound-bodies',
    armed: process.env[GATE_ENV] === '1',
    gateEnv: GATE_ENV,
    pending,
    usage: 'POST (admin) with optional {"dryRun":true}; cap 50/run — repeat until remaining=0',
  });
}
