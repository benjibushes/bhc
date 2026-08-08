// app/api/admin/marketing-scoreboard/route.ts
//
// P6′ — THE MARKETING SCOREBOARD (MARKETING-REVAMP-2026-08 §5 Convergence +
// §7). One read-only endpoint behind /admin/today that answers, weekly:
// lane sizes, sends by stream, deposit funnel, complaint rate, digest
// last-run, closes — plus EVENT-COUNT evaluation gates ("evaluating —
// 43/200 events"), never fixed 2-week windows.
//
// READ-ONLY. GET aggregations only — no Airtable writes, no sends, no PII
// beyond counts (repo is public; responses are counts and cron-note text
// which is itself count-only).
//
// Airtable budget (org limit 5 req/s shared with ~60 crons):
//   • The whole payload is assembled once per 60s under ONE adminSnapshot
//     key (L1 memo + shared Redis) — a polling client costs zero reads
//     inside the window.
//   • Referrals rides the SHARED `table:Referrals` snapshot every other
//     admin surface already uses (3-min TTL) — zero extra scans when the
//     cockpit is open.
//   • Cron Runs is ONE 7d name-filtered read (reclassify-buyers +
//     ranch-stand-digest rows only — a handful of rows). Lane sizes are
//     parsed out of the reclassify note: zero Consumers scans (plan §5:
//     "seeded free from reclassify-buyers' Cron Runs notes").
//   • Email Sends is one 7d sent-filtered read (same formula shape as
//     primeFrequencyCapCache) + one small template-filtered read for the
//     digest-deliveries gate (bounded by the table's 90d log-retention).
//   • Complaints reuse lib/complaintTelemetry ({Complained}=TRUE() reads —
//     a handful of records by construction).
//
// CONTRACT (same as /api/admin/today): every band is independently
// fail-soft. A failed read or unparseable note nulls THAT band; the route
// never 500s past auth.

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { adminSnapshot, adminSnapshotTable } from '@/lib/adminSnapshot';
import { requireAdmin } from '@/lib/adminAuth';
import {
  countRecentComplaints,
  COMPLAINT_ALERT_THRESHOLD,
} from '@/lib/complaintTelemetry';
import {
  parseReclassifyNote,
  laneSizesFromSegments,
  parseDigestNote,
  latestCronRunByName,
  countSendsByStream,
  countDepositFunnel,
  computeFunnelRates,
  countClosedWonSince,
  gateProgress,
} from '@/lib/marketingScoreboard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Whole-payload cache TTL — the client polls no faster than 120s. */
const SCOREBOARD_TTL_MS = 60 * 1000;
/** Cron Runs lookback — both source crons run daily; 7d survives outages. */
const CRON_LOOKBACK_MS = 7 * DAY_MS;

// Evaluation gates (plan §7 — event counts, never calendar windows).
const DIGEST_GATE_TARGET = 200; // digest deliveries before P3′ is judged
const SPRINT_GATE_TARGET = 20; // sprint entries before P5′ is judged

async function buildScoreboard() {
  const now = Date.now();

  const safe = async <T>(fn: () => Promise<T>, label: string): Promise<T | null> => {
    try {
      return await fn();
    } catch (e: any) {
      console.warn(`[admin/marketing-scoreboard] ${label} read failed:`, e?.message);
      return null;
    }
  };

  const since7dISO = new Date(now - 7 * DAY_MS).toISOString();
  const cronCutoffISO = new Date(now - CRON_LOOKBACK_MS).toISOString();

  const [referrals, cronRows, sends7d, digestSendsAllTime, complaints7d] = await Promise.all([
    safe(() => adminSnapshotTable(TABLES.REFERRALS), 'referrals'),
    safe(
      () =>
        getAllRecords(
          TABLES.CRON_RUNS,
          `AND(IS_AFTER({Started At}, "${cronCutoffISO}"), OR({Name}="reclassify-buyers", {Name}="ranch-stand-digest"))`,
        ) as Promise<Record<string, unknown>[]>,
      'cronRuns',
    ),
    safe(
      () =>
        getAllRecords(
          TABLES.EMAIL_SENDS,
          `AND({Sent At} > "${since7dISO}", {Status}="sent")`,
        ) as Promise<Record<string, unknown>[]>,
      'emailSends7d',
    ),
    // Cumulative digest deliveries for the P3′ gate. "All time" is bounded
    // in practice by Email Sends' 90-day log-retention — labeled as such in
    // the gate metric so the number is never oversold.
    safe(
      () =>
        getAllRecords(
          TABLES.EMAIL_SENDS,
          `AND({Template Name}="ranch_stand_digest", {Status}="sent")`,
        ) as Promise<Record<string, unknown>[]>,
      'digestSends',
    ),
    safe(() => countRecentComplaints(now), 'complaints'),
  ]);

  // ── Lanes — parsed out of the latest reclassify-buyers note ─────────────
  let lanes: {
    shareReady: number;
    national: number;
    customer: number;
    total: number | null;
    asOf: string | null;
  } | null = null;
  if (cronRows) {
    const run = latestCronRunByName(cronRows, 'reclassify-buyers');
    const parsed = run ? parseReclassifyNote(run['Notes']) : null;
    if (parsed) {
      lanes = {
        ...laneSizesFromSegments(parsed.segments),
        total: parsed.total,
        asOf: String(run?.['Started At'] || '') || null,
      };
    }
  }

  // ── Sends by stream, trailing 7d ────────────────────────────────────────
  const sendsByStream = sends7d
    ? { windowDays: 7, ...countSendsByStream(sends7d) }
    : null;

  // ── Deposit funnel, trailing 30d ────────────────────────────────────────
  let depositFunnel: any = null;
  if (referrals) {
    const counts = countDepositFunnel(referrals, now - 30 * DAY_MS);
    depositFunnel = { windowDays: 30, ...counts, rates: computeFunnelRates(counts) };
  }

  // ── Complaint rate, trailing 7d (P2.5 telemetry + threshold state) ──────
  const complaints =
    complaints7d === null
      ? null
      : {
          count7d: complaints7d,
          threshold: COMPLAINT_ALERT_THRESHOLD,
          alert: complaints7d >= COMPLAINT_ALERT_THRESHOLD,
        };

  // ── Digest — latest ranch-stand-digest note passthrough + parse ─────────
  let digest: any = null;
  if (cronRows) {
    const run = latestCronRunByName(cronRows, 'ranch-stand-digest');
    if (run) {
      digest = {
        asOf: String(run['Started At'] || '') || null,
        status: String(run['Status'] || '') || null,
        note: String(run['Notes'] || ''),
        parsed: parseDigestNote(run['Notes']),
      };
    }
    // No row in 7d → digest stays null → the UI's "no digest run yet".
  }

  // ── Weekly closes ───────────────────────────────────────────────────────
  const closes = referrals
    ? { windowDays: 7, ...countClosedWonSince(referrals, now - 7 * DAY_MS) }
    : null;

  // ── Evaluation gates (event counts) ─────────────────────────────────────
  // Sprint entries = deposit-invite intent arcs opened (the 'Deposit Invite
  // Sent At' stamp IS the P5′ sprint entry event) in the funnel's 30d
  // window. Digest deliveries = cumulative sent rows within log retention.
  const gates = [
    digestSendsAllTime
      ? gateProgress(
          "P3′ digest",
          'digest deliveries (90d retention)',
          digestSendsAllTime.length,
          DIGEST_GATE_TARGET,
        )
      : null,
    depositFunnel
      ? gateProgress(
          "P5′ sprints",
          'sprint entries (30d)',
          depositFunnel.inviteSent,
          SPRINT_GATE_TARGET,
        )
      : null,
  ].filter(Boolean);

  return {
    generatedAt: new Date(now).toISOString(),
    lanes,
    sendsByStream,
    depositFunnel,
    complaints,
    digest,
    closes,
    gates,
  };
}

export async function GET(request: Request) {
  const authResp = await requireAdmin(request);
  if (authResp) return authResp;

  const payload = await adminSnapshot('marketing-scoreboard', buildScoreboard, SCOREBOARD_TTL_MS);
  return NextResponse.json(payload);
}
