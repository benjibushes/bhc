// app/api/cron/learning-report/route.ts
//
// THE GATED WEEKLY LEARNING REPORT (ADAPTIVE-MARKETING-DESIGN PR 3 — the
// founder-protection layer). Every Monday this drops the honest state of the
// adaptive-marketing experiments into Telegram: per-template variant counts
// with the prespecified Fisher's exact test (α=0.05, clicks only), Wilson
// CIs, the replication verdict on last week's top finding, the n/arm still
// required to judge the prespecified +20% lift, and the distance to every
// killed knob's volume trigger. ALL of the intelligence is pure and
// unit-tested in lib/learningReport; this route is reads + delivery.
//
// NULL-CAPABLE BY DESIGN: at current volume the expected report says
// "insufficient data / nothing passed the gate" — and that ships as-is.
// A synthesis that always finds something is a noise generator.
//
// SCHEDULING (design doc §PR 3, verbatim): DAILY slot + Monday guard INSIDE
// realHandler. A true weekly vercel.json slot would live in EXCLUDED_CRONS_24H
// and EXCLUDED crons never alarm — this cron would be watchdog-blind. Instead
// it runs daily at 14:10 UTC, writes a "skipped: not Monday" Cron Runs row six
// days a week, and sits in EXPECTED_CRONS_24H: a missing row always means a
// REAL missed run. (Mondays it lands 10 minutes after weekly-scorecard.)
//
// GATING (design doc §PR 3 scope): report GENERATION always runs — it is
// read-only over Airtable (Email Sends, Consumers, Cron Runs) and writes
// nothing but its own Cron Runs row (via withCronRun; the replication ledger
// token rides that row's Notes, the campaign-autopilot stats[] precedent).
// What is gated is CONCLUSIONS: the evidence gates live in lib/learningReport
// and the killed-knob volume triggers are restated in every report so Ben
// sees which learning mechanisms are still below unlock volume and how far.
//
// PUBLIC-REPO / PII RULE: counts only. Template names, variant letters, state
// codes, slugs — never an email, never a buyer name, in code, notes, or the
// Telegram body.

import { getAllRecords, getRecordsByIds, TABLES } from '@/lib/airtable';
import { requireCron } from '@/lib/cronAuth';
import { withCronRun } from '@/lib/cronRun';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { normalizeState } from '@/lib/states';
import {
  perTemplateArms,
  parseEligiblePool,
  parseLedgerToken,
  countRecipientsWithLifetimeClicks,
  buildLearningReport,
  CAMPAIGN_TEMPLATE_PREFIX,
  type LedgerParse,
  type VolumeInputs,
} from '@/lib/learningReport';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const DAY_MS = 24 * 60 * 60 * 1000;

interface CronResult {
  status: 'success' | 'partial';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<CronResult> {
  const now = new Date();

  // MONDAY GUARD — inside realHandler so the other six days still write a
  // Cron Runs row and EXPECTED_CRONS_24H stays honest (see header).
  if (now.getUTCDay() !== 1) {
    return {
      status: 'success',
      recordsTouched: 0,
      notes: 'skipped: not Monday (weekly report on a daily slot — the watchdog-visibility pattern)',
    };
  }

  const degradations: string[] = [];

  // ── Read 1 (core): every variant-relevant campaign send, cumulative. ──────
  // The experiment accumulates until a template's wave exhausts its pool
  // (design doc §PR 1), so the test always runs over cumulative counts; the
  // replication ledger isolates the new week via last week's frozen token.
  // A failed core read = no report — a report over unknown data is exactly
  // the fabricated-conclusion failure mode this PR exists to prevent.
  let campaignRows: Array<Record<string, unknown>>;
  try {
    campaignRows = (await getAllRecords(
      TABLES.EMAIL_SENDS,
      `AND(FIND('${CAMPAIGN_TEMPLATE_PREFIX}', {Template Name}) = 1, {Status} = "sent")`,
      {
        fields: [
          'Template Name',
          'Variant',
          'Sent At',
          'Delivered At',
          'Opened At',
          'Clicked At',
          'Recipient Consumer',
        ],
      },
    )) as Array<Record<string, unknown>>;
  } catch (e: any) {
    return {
      status: 'partial',
      recordsTouched: 0,
      notes: `email-sends read failed — no report sent (a report over unknown data would fabricate conclusions): ${String(e?.message).slice(0, 120)}`,
    };
  }

  const { templates, unattributed } = perTemplateArms(campaignRows);

  // Trailing-7d sends/day (bandit trigger) — from the rows already in hand.
  const sevenDaysAgo = now.getTime() - 7 * DAY_MS;
  const sends7d = campaignRows.filter((r) => {
    const t = new Date(String(r['Sent At'] || '')).getTime();
    return Number.isFinite(t) && t >= sevenDaysAgo;
  }).length;

  // ── Read 2: lifetime clicked rows, ALL templates (send-hour trigger). ─────
  // Server-side filtered to clicked rows only — a tiny read by construction.
  let recipientsWith10PlusClicks = 0;
  try {
    const clicked = (await getAllRecords(TABLES.EMAIL_SENDS, `{Clicked At} != ''`, {
      fields: ['Recipient Email'],
    })) as Array<Record<string, unknown>>;
    recipientsWith10PlusClicks = countRecipientsWithLifetimeClicks(clicked);
  } catch (e: any) {
    degradations.push('lifetime-clicks read failed (send-hour trigger shows 0)');
    console.warn('[learning-report] clicked-rows read failed:', e?.message);
  }

  // ── Read 3: states of clicked campaign sends (state-cut trigger). ─────────
  // Clicked campaign rows are few; getRecordsByIds chunks the id lookup.
  let maxStateClicks: VolumeInputs['maxStateClicks'] = null;
  try {
    const clickedConsumerIds = [
      ...new Set(
        campaignRows
          .filter((r) => String(r['Clicked At'] || ''))
          .flatMap((r) => (Array.isArray(r['Recipient Consumer']) ? r['Recipient Consumer'] : []))
          .filter(Boolean),
      ),
    ];
    if (clickedConsumerIds.length > 0) {
      const consumers = await getRecordsByIds(TABLES.CONSUMERS, clickedConsumerIds);
      const stateById = new Map<string, string>();
      for (const c of consumers) stateById.set(c.id, normalizeState(c['State']) || '');
      const perState = new Map<string, number>();
      for (const r of campaignRows) {
        if (!String(r['Clicked At'] || '')) continue;
        const id = Array.isArray(r['Recipient Consumer']) ? r['Recipient Consumer'][0] : undefined;
        const st = (id && stateById.get(id)) || '';
        if (!st) continue;
        perState.set(st, (perState.get(st) || 0) + 1);
      }
      for (const [state, clicks] of perState) {
        if (!maxStateClicks || clicks > maxStateClicks.clicks) maxStateClicks = { state, clicks };
      }
    }
  } catch (e: any) {
    degradations.push('state join failed (state-cut trigger shows no state)');
    console.warn('[learning-report] state join failed:', e?.message);
  }

  // ── Read 4: the autopilot's latest logged eligible-pool size. ─────────────
  let eligiblePool: number | null = null;
  try {
    const runs = (await getAllRecords(
      TABLES.CRON_RUNS,
      `AND({Name} = "campaign-autopilot", IS_AFTER({Started At}, "${new Date(now.getTime() - 7 * DAY_MS).toISOString()}"))`,
    )) as any[];
    runs.sort((a, b) => new Date(b['Started At']).getTime() - new Date(a['Started At']).getTime());
    for (const r of runs) {
      const pool = parseEligiblePool(r['Notes']);
      if (pool !== null) {
        eligiblePool = pool;
        break;
      }
    }
  } catch (e: any) {
    degradations.push('autopilot cron-run read failed (pool unknown)');
    console.warn('[learning-report] autopilot run read failed:', e?.message);
  }

  // ── Read 5: last week's ledger token (this cron's own prior Cron Runs). ───
  let prior: LedgerParse = { kind: 'absent' };
  try {
    const runs = (await getAllRecords(
      TABLES.CRON_RUNS,
      `AND({Name} = "learning-report", IS_AFTER({Started At}, "${new Date(now.getTime() - 15 * DAY_MS).toISOString()}"))`,
    )) as any[];
    runs.sort((a, b) => new Date(b['Started At']).getTime() - new Date(a['Started At']).getTime());
    for (const r of runs) {
      const parsed = parseLedgerToken(r['Notes']);
      if (parsed.kind !== 'absent') {
        prior = parsed;
        break;
      }
    }
  } catch (e: any) {
    degradations.push('prior-report read failed (ledger treated as first run)');
    console.warn('[learning-report] prior-report read failed:', e?.message);
  }

  // ── Assemble (pure) + deliver. ────────────────────────────────────────────
  const report = buildLearningReport({
    templates,
    unattributed,
    volume: {
      sendsPerDay7d: sends7d / 7,
      eligiblePool,
      recipientsWith10PlusClicks,
      maxStateClicks,
    },
    prior,
    nowMs: now.getTime(),
  });

  const lines = [...report.lines];
  if (degradations.length > 0) {
    lines.push('');
    lines.push(`⚠️ degraded reads this run: ${degradations.join(' · ')}`);
  }

  let telegramFailed = false;
  await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, lines.join('\n')).catch((e: any) => {
    telegramFailed = true;
    console.error('[learning-report] telegram send failed:', e?.message);
  });

  return {
    // Degraded reads or a failed delivery = partial (operator alerted by
    // withCronRun); the note keeps the ledger token either way so next
    // Monday's replication join never loses its baseline.
    status: telegramFailed || degradations.length > 0 ? 'partial' : 'success',
    recordsTouched: 0,
    notes:
      (telegramFailed ? 'TELEGRAM SEND FAILED · ' : '') +
      (degradations.length ? `degraded: ${degradations.join('; ')} · ` : '') +
      report.notes,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('learning-report', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
