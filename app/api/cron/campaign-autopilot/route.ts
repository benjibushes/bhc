// app/api/cron/campaign-autopilot/route.ts
//
// THE CAMPAIGN AUTOPILOT (ADAPTIVE-MARKETING-DESIGN PR 2) — the trigger
// removal: the requalify campaign machine no longer waits for an operator to
// hand it a batch. Daily, this cron derives the next first-touch wave
// (lib/campaignWaves — pure, fully unit-tested) and works it through the
// EXISTING requalify-send flow by self-calling POST /api/campaign/
// requalify-send with CRON_SECRET (the triggerLaunchWarmup precedent). No
// new Resend-facing code, no second send loop, no second classifier: the
// endpoint's own belts (baked template, CTA decision, claim-before-send
// stamps, domain budget, suppression, frequency cap, variants) all apply
// unchanged.
//
// RAIL DISJOINTNESS (design doc §PR 2): this rail owns FIRST TOUCH of
// never-campaigned buyers (no claim stamp of any kind); the demand-router
// owns post-engagement arcs + recovery. The 7d cross-rail belt plus the
// shared 3/week frequency cap (inside guardedSend) are the fuses.
//
// SAFETY STACK (each layer independent):
//   • Tri-state CAMPAIGN_AUTOPILOT_ENABLED, FAIL-TO-OFF: unset/anything →
//     off (this handler logs 'disabled' and exits — gate INSIDE realHandler
//     so a daily Cron Runs row always lands and EXPECTED_CRONS_24H stays
//     honest, the demand-router pattern). 'dry-run' = L0 shadow: full
//     selection + logged plan, ZERO sends, zero writes. 'true' = live.
//   • AUTO-PAUSE, fail-closed, checked before every live run: complaints
//     ≥3/7d · >5 hard bounces/24h · prior-run send-failure >10% · any
//     telemetry read failure. A tripped guard sends an operator signal and
//     the run does nothing.
//   • BUDGET: ramp 30/day until 3 distinct live-send days, then 120/day
//     (DAILY_CAMPAIGN_BUDGET — which the requalify endpoint ALSO enforces
//     server-side against Email Sends truth, so this cron can never talk
//     itself past the domain ceiling). Marketing-subdomain DKIM warmup
//     (MARKETING_SEND_DOMAIN set, MARKETING_DOMAIN_WARMED≠'true') holds the
//     ramp cap regardless.
//   • Claim-before-send + revert-on-failure live INSIDE requalify-send
//     (PR 1) — every buyer this cron touches carries a durable
//     `Campaign Last Sent At` + `Campaign Rail`='autopilot' stamp.
//   • Counts only in notes/logs — no buyer PII (public repo rule).
//
// NOT BUILT (recorded): the design doc's cancel-scheduled sweep has nothing
// to cancel on this rail — v1 sends at cron hour through requalify-send,
// which never uses Resend `scheduledAt`; there are no pending scheduled
// sends to sweep. Revisit if a send-hour optimizer ever lands (its volume
// trigger: >500 recipients with ≥10 lifetime clicks).

import { getAllRecords, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { requireCron } from '@/lib/cronAuth';
import { withCronRun } from '@/lib/cronRun';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { countRecentComplaints } from '@/lib/complaintTelemetry';
import { activeDealBuyerKeys } from '@/lib/demandRouter';
import {
  autopilotMode,
  domainWarmupHold,
  autoPauseReason,
  selectCampaignWaves,
  countBounceStampsSince,
  countDistinctSendDays,
  formatRunStats,
  parseRunStats,
  AUTOPILOT_RAIL,
  type GuardTelemetry,
  type WavePlan,
} from '@/lib/campaignWaves';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
const SOFT_DEADLINE_MS = 240_000;
/** Per-batch self-call timeout — the callee paces ~600ms/send × ≤60. */
const BATCH_TIMEOUT_MS = 150_000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface CronResult {
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}

// ── Guard telemetry (each read independently fail-closed → null = alarm) ────

async function readGuardTelemetry(now: Date): Promise<GuardTelemetry> {
  let complaints7d: number | null = null;
  try {
    complaints7d = await countRecentComplaints(now.getTime());
  } catch (e: any) {
    console.warn('[campaign-autopilot] complaint telemetry read failed:', e?.message);
  }

  let bounces24h: number | null = null;
  try {
    // Day-floored 24h window (the complaintTelemetry rule — webhook stamps
    // are UTC-day granular; the bias runs toward pausing early, never late).
    const windowStart = now.getTime() - DAY_MS;
    const sinceMs = windowStart - (windowStart % DAY_MS);
    const bounced = (await getAllRecords(
      TABLES.CONSUMERS,
      `{Bounced} = TRUE()`,
    )) as Array<Record<string, unknown>>;
    bounces24h = countBounceStampsSince(bounced, sinceMs);
  } catch (e: any) {
    console.warn('[campaign-autopilot] bounce telemetry read failed:', e?.message);
  }

  let priorRun: GuardTelemetry['priorRun'] = null;
  try {
    const sinceIso = new Date(now.getTime() - 2 * DAY_MS).toISOString();
    const rows = (await getAllRecords(
      TABLES.CRON_RUNS,
      `AND({Name} = "campaign-autopilot", IS_AFTER({Started At}, "${sinceIso}"))`,
    )) as any[];
    rows.sort(
      (a, b) => new Date(b['Started At']).getTime() - new Date(a['Started At']).getTime(),
    );
    const withStats = rows
      .map((r) => parseRunStats(r['Notes']))
      .find((s) => s !== null);
    priorRun = withStats ?? 'none';
  } catch (e: any) {
    console.warn('[campaign-autopilot] prior-run read failed:', e?.message);
  }

  return { complaints7d, bounces24h, priorRun };
}

// ── Plan summary for the Cron Runs note (counts + public slugs ONLY) ────────

function planNote(plan: WavePlan): string {
  const b = plan.budget;
  const ceiling = `ceiling=${b.ceiling}${
    b.rampReason === 'ramp-days'
      ? '(ramp)'
      : b.rampReason === 'domain-warmup'
        ? '(warmup-hold)'
        : '(full)'
  }`;
  const skips = Object.entries(plan.skips)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ') || 'none';
  const states =
    plan.stateTable.map((s) => `${s.state}→${s.slug}`).join(' ') || 'no served states';
  return (
    `${ceiling} remaining=${b.remaining} eligible=${plan.eligible} ` +
    `selected=${plan.selected} batches=${plan.batches.length} · ` +
    `skips: ${skips} · states: ${states}`
  );
}

// ── Handler ─────────────────────────────────────────────────────────────────

async function realHandler(_request: Request): Promise<CronResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  // KILL-SWITCH — tri-state, fail-to-off, INSIDE realHandler (daily Cron
  // Runs row lands either way; the demand-router/ranch-stand-digest pattern).
  const mode = autopilotMode();
  if (mode === 'off') {
    return {
      status: 'success',
      recordsTouched: 0,
      notes:
        "disabled: CAMPAIGN_AUTOPILOT_ENABLED is not 'true' or 'dry-run' (fail-to-off) — no selection, no sends",
    };
  }

  const now = new Date();
  const runStartMs = Date.now();

  // AUTO-PAUSE GATES (design doc: checked before every run, fail closed).
  const guards = await readGuardTelemetry(now);
  const pause = autoPauseReason(guards);
  if (pause && mode === 'live') {
    // The machine refuses to send and says so ONCE (deduped 24h) — never a
    // silent stall.
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'system-error',
      summary: 'CAMPAIGN AUTOPILOT auto-paused',
      detail: `${pause}. Zero sends this run; the gate re-evaluates on the next daily tick.`,
      refs: [{ type: 'cron', id: 'campaign-autopilot' }],
      dedupeKey: 'campaign-autopilot:auto-pause',
      dedupeWindowMs: 24 * 60 * 60 * 1000,
    }).catch(() => {});
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `AUTO-PAUSED (zero sends): ${pause} · complaints7d=${guards.complaints7d} bounces24h=${guards.bounces24h}`,
    };
  }

  // ── Reads. Consumers/Ranchers throwing → withCronRun records the error. ──
  // The Consumers formula is a cheap prefilter (suppression flags + the
  // first-touch claim field); every gate re-checks purely in campaignWaves.
  const [consumers, ranchers] = await Promise.all([
    getAllRecords(
      TABLES.CONSUMERS,
      'AND(' +
        '{Email} != "", ' +
        'NOT({Unsubscribed} = TRUE()), ' +
        'NOT({Bounced} = TRUE()), ' +
        'NOT({Complained} = TRUE()), ' +
        "{Campaign Last Sent At} = ''" +
        ')',
    ) as Promise<any[]>,
    getAllRecords(TABLES.RANCHERS) as Promise<any[]>,
  ]);

  // Mid-deal belt — referral truth, the same statuses + pure index the
  // demand-router uses (activeDealBuyerKeys). Fail-open with a warn (the
  // demand-router posture): the lane gate already parks most mid-deal buyers
  // in TERMINAL via the Referral Status mirror, and the degradation is named
  // in the note.
  let activeDealRows: Array<Record<string, unknown>> = [];
  let activeDealReadFailed = false;
  try {
    activeDealRows = (await getAllRecords(
      TABLES.REFERRALS,
      `OR({Status} = "Intro Sent", {Status} = "Rancher Contacted", {Status} = "Negotiation", {Status} = "Awaiting Payment", {Status} = "Slot Locked", {Status} = "Pending Approval")`,
    )) as Array<Record<string, unknown>>;
  } catch (e: any) {
    activeDealReadFailed = true;
    console.warn('[campaign-autopilot] active-deal read failed — mid-deal belt degraded to segment mirrors:', e?.message);
  }

  // BUDGET TRUTH — today's domain-wide campaign_* sends (the same Email
  // Sends formula the requalify endpoint enforces its ceiling with). A
  // failed read in LIVE mode refuses to send blind (the endpoint would
  // refuse too — this just fails earlier and louder).
  let sentToday: number | null = null;
  try {
    const today = now.toISOString().slice(0, 10);
    const rows = await getAllRecords(
      TABLES.EMAIL_SENDS,
      `AND(FIND('campaign_', {Template Name}) = 1, IS_SAME({Sent At}, '${today}', 'day'))`,
    );
    sentToday = rows.length;
  } catch (e: any) {
    console.warn('[campaign-autopilot] sent-today read failed:', e?.message);
  }
  if (sentToday === null && mode === 'live') {
    return {
      status: 'partial',
      recordsTouched: 0,
      notes: 'budget telemetry read failed — refusing to send blind (fail closed); zero sends',
    };
  }

  // RAMP PROGRESS — distinct UTC days with ≥1 autopilot send in the trailing
  // 14d. A failed read falls back to 0 prior days = ramp cap (fail-SMALL,
  // never fail-big).
  let priorLiveSendDays = 0;
  let rampReadFailed = false;
  try {
    const sinceIso = new Date(now.getTime() - 14 * DAY_MS).toISOString();
    const rows = (await getAllRecords(
      TABLES.EMAIL_SENDS,
      `AND(FIND('campaign_autopilot', {Template Name}) = 1, IS_AFTER({Sent At}, '${sinceIso}'))`,
    )) as any[];
    priorLiveSendDays = countDistinctSendDays(rows.map((r) => r['Sent At']));
  } catch (e: any) {
    rampReadFailed = true;
    console.warn('[campaign-autopilot] ramp-days read failed — holding ramp cap:', e?.message);
  }

  // ── PURE PLAN — the entire policy lives in lib/campaignWaves. ────────────
  const plan = selectCampaignWaves({
    consumers,
    ranchers: ranchers as any,
    activeDeals: activeDealBuyerKeys(activeDealRows),
    now: now.getTime(),
    budget: {
      sentToday: sentToday ?? 0,
      priorLiveSendDays,
      domainWarming: domainWarmupHold(),
    },
  });

  const degradations = [
    ...(activeDealReadFailed ? ['active-deal-read-failed'] : []),
    ...(rampReadFailed ? ['ramp-read-failed(held-at-ramp)'] : []),
  ];
  const skipReasonBreakdown: Record<string, number> = Object.fromEntries(
    Object.entries(plan.skips).filter(([, n]) => (n as number) > 0),
  ) as Record<string, number>;
  const baseNote =
    planNote(plan) + (degradations.length ? ` · degraded: ${degradations.join(' ')}` : '');

  if (mode === 'dry-run') {
    // L0 SHADOW: the operator reads this exact plan for a clean week, then
    // flips the env (design doc §3 rollout gates). Zero sends, zero writes.
    return {
      status: 'success',
      recordsTouched: 0,
      notes:
        `DRY-RUN (CAMPAIGN_AUTOPILOT_ENABLED='dry-run', L0 shadow) — would dispatch ${baseNote}` +
        (pause ? ` · guards: WOULD PAUSE — ${pause}` : ' · guards: clean'),
      skipReasonBreakdown,
    };
  }

  // ── LIVE dispatch — self-call the requalify-send endpoint per batch. ─────
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    // requireCron passed, so this is unreachable in practice — belt only.
    return { status: 'partial', recordsTouched: 0, notes: 'CRON_SECRET unset — cannot self-call; zero sends' };
  }

  let attempted = 0;
  let sent = 0;
  let suppressed = 0;
  let failed = 0;
  let oneTap = 0;
  let quizFallback = 0;
  let dispatched = 0;
  let deadlineExit = false;
  const failures: string[] = [];

  for (const batch of plan.batches) {
    if (Date.now() - runStartMs > SOFT_DEADLINE_MS) {
      // Exit honestly (the batch-approve lesson): the untouched tail is
      // still unclaimed, so tomorrow's run picks it up.
      deadlineExit = true;
      break;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${SITE_URL}/api/campaign/requalify-send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cronSecret}`,
        },
        body: JSON.stringify({
          campaign: `autopilot-${batch.state.toLowerCase()}`,
          rail: AUTOPILOT_RAIL,
          rancher: { name: batch.rancherName, slug: batch.rancherSlug },
          recipients: batch.recipients,
          dryRun: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // FAIL CLOSED on any endpoint refusal (budget 429, lookup 503, …):
        // stop dispatching — the refusal reason applies to every later batch
        // too, and a campaign email is never urgent enough to push through.
        const errBody = await res.json().catch(() => ({}) as any);
        failures.push(
          `${batch.rancherSlug}/${batch.state}: HTTP ${res.status} — ${String((errBody as any)?.error || res.statusText).slice(0, 120)} (dispatch stopped)`,
        );
        break;
      }
      const out = (await res.json()) as {
        sent?: number;
        suppressed?: number;
        failed?: number;
        oneTap?: number;
        quizFallback?: number;
        claimFailures?: string[];
      };
      dispatched += 1;
      attempted += batch.recipients.length;
      sent += Number(out.sent) || 0;
      suppressed += Number(out.suppressed) || 0;
      failed += Number(out.failed) || 0;
      oneTap += Number(out.oneTap) || 0;
      quizFallback += Number(out.quizFallback) || 0;
      if (Array.isArray(out.claimFailures) && out.claimFailures.length > 0) {
        // Counts only — the endpoint's claimFailures strings carry emails.
        failures.push(`${batch.rancherSlug}/${batch.state}: ${out.claimFailures.length} claim anomalies (see requalify-send logs)`);
      }
    } catch (e: any) {
      // Timeout/network mid-batch: the callee's claim-before-send stamps make
      // a partial batch safe (claimed rows are never re-sent). Stop here.
      failures.push(
        `${batch.rancherSlug}/${batch.state}: self-call ${controller.signal.aborted ? 'timed out' : 'failed'} — ${String(e?.message || 'unknown').slice(0, 80)} (dispatch stopped)`,
      );
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  const stats = formatRunStats({ attempted, sent, suppressed, failed });
  const status: CronResult['status'] = failures.length > 0 ? 'partial' : 'success';
  const notes =
    `LIVE ${stats} oneTap=${oneTap} quiz=${quizFallback} ` +
    `dispatched=${dispatched}/${plan.batches.length}${deadlineExit ? ' DEADLINE-EXIT (tail waits for tomorrow)' : ''} · ` +
    baseNote +
    (failures.length ? ` · failures: ${failures.join(' | ')}` : '');

  return { status, recordsTouched: sent, notes, skipReasonBreakdown };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('campaign-autopilot', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
