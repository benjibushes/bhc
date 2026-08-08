// app/api/cron/ranch-stand-digest/route.ts
//
// THE RANCH STAND DIGEST (P3′, MARKETING-REVAMP-2026-08 §5 Convergence).
//
// Monthly merchandising email for every marketing-lane consumer — the first
// program send that markets what the recipient can actually buy. Runs DAILY
// (Vercel has silently dropped monthly slots on this project — the
// commission-invoices precedent) and only SENDS inside the month's day-1-to-4
// window, engagement-tiered:
//
//   UTC day 1 → tier 1 (most recently engaged quartile)
//   UTC day 2 → tier 2 … day 4 → tier 4 (least engaged)
//   any other day → honest no-op Cron Runs note.
//
// Never one full-list send day — the tiered rollout is the deliverability
// warmup the 2026-08-08 panel required in place of the "full consented list"
// v1 idea.
//
// SAFETY STACK (each layer independent):
//   - RANCH_STAND_DIGEST_ENABLED !== 'true' → dry-run: full selection +
//     tier math reported in the Cron Runs note, ZERO sends, zero writes
//     (the state-coverage-notify precedent; gate is INSIDE realHandler so a
//     daily row always lands and EXPECTED_CRONS_24H stays honest).
//   - Pure selection (lib/ranchStandDigest.ts): suppression flags, synthetic
//     addresses, the 180d/12mo never-engaged deliverability gates (P5′
//     re-permission owns the sunset cohort — this cron only ever excludes),
//     and the 1-per-25-days cadence cap read from the dated Notes marker.
//   - Claim-before-send: Redis claimOnce per (consumer, month) BEFORE the
//     send; the dated DIGEST_MARKER Notes stamp after the outcome is the
//     durable anchor (hard rule 2 — send truth persisted on the record).
//   - guardedSend underneath ('ranch_stand_digest', marketing stream):
//     suppression list + 3/week frequency cap + Email Sends audit log +
//     forced List-Unsubscribe/one-click headers (#575).
//   - DIGEST_RUN_CAP 200/run + 400ms pacing; a capped tail simply waits for
//     next month (the Notes stamp keeps selection walking, never re-heading).

import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendRanchStandDigest } from '@/lib/emailMinimal';
import { primeFrequencyCapCache } from '@/lib/emailFrequencyGuard';
import { claimOnce } from '@/lib/rancherCapacity';
import { getServedStates } from '@/lib/routingSegment';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import {
  DIGEST_RUN_CAP,
  selectNewArrivals,
  isThinMonth,
  selectShelfHighlights,
  latestCloseFromRefs,
  ranchStoryForMonth,
  tierForDayOfMonth,
  classifyDigestRecipient,
  assignTiers,
  buildDigestMarkerLine,
  renderRanchStandDigest,
  type DigestSkipReason,
} from '@/lib/ranchStandDigest';

export const maxDuration = 300;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
const SOFT_DEADLINE_MS = 240_000;

async function realHandler(_request: Request): Promise<{
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const now = new Date();
  const nowMs = now.getTime();
  const tier = tierForDayOfMonth(now.getUTCDate());
  if (tier === null) {
    // Date guard (the commission-invoices/compliance-reminders pattern,
    // widened to the 4-day tier window): a daily row proves we DID check.
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `skipped — outside send window (UTC day=${now.getUTCDate()}; digest sends days 1-4, tiered)`,
    };
  }

  const live = process.env.RANCH_STAND_DIGEST_ENABLED === 'true';
  const runStartMs = Date.now();

  // One read each; every selector downstream is pure over these rows.
  const [consumers, ranchers, productRows, closedWonRefs] = await Promise.all([
    getAllRecords(TABLES.CONSUMERS) as Promise<any[]>,
    getAllRecords(TABLES.RANCHERS) as Promise<any[]>,
    getAllRecords(TABLES.RANCHER_PRODUCTS) as Promise<any[]>,
    // Same hygiene source as /wins + lib/socialProof — Closed Won only; the
    // pure helper trims it to first name + state (never a full buyer name).
    (getAllRecords(TABLES.REFERRALS, '{Status} = "Closed Won"') as Promise<any[]>).catch(() => [] as any[]),
  ]);

  // ── Content (shared across every recipient this run) ──────────────────
  const servedStates = getServedStates(ranchers); // P1′ helper, capacity-OUT
  const newArrivals = selectNewArrivals(productRows, nowMs);
  const thinMonth = isThinMonth(newArrivals);
  const shownArrivals = thinMonth ? [] : newArrivals;
  const shelf = selectShelfHighlights(productRows, {
    excludeIds: new Set(shownArrivals.map((p) => p.id)),
  });
  const latestClose = latestCloseFromRefs(closedWonRefs);
  const story = ranchStoryForMonth(now.getUTCMonth());

  // ── Recipients → engagement tiers ─────────────────────────────────────
  const skips: Record<DigestSkipReason, number> = {
    'no-email': 0,
    synthetic: 0,
    suppressed: 0,
    'skipped-neverengaged': 0,
    'skipped-sunset': 0,
    'recently-sent': 0,
  };
  const eligible = [];
  for (const c of consumers) {
    const decision = classifyDigestRecipient(c, nowMs);
    if (decision.eligible) eligible.push(decision.target);
    else skips[decision.reason]++;
  }
  const tiers = assignTiers(eligible);
  const tierSizes = tiers.map((t) => t.length);
  const todays = tiers[tier - 1];
  const selected = todays.slice(0, DIGEST_RUN_CAP);

  const baseNote =
    `tier=${tier} tier-sizes=[${tierSizes.join(',')}] eligible=${eligible.length} ` +
    `selected=${selected.length}${todays.length > DIGEST_RUN_CAP ? ` (run-cap ${DIGEST_RUN_CAP} of ${todays.length})` : ''} ` +
    `skipped-sunset=${skips['skipped-sunset']} skipped-neverengaged=${skips['skipped-neverengaged']} ` +
    `suppressed-flags=${skips.suppressed} recently-sent=${skips['recently-sent']} ` +
    `thin-month=${thinMonth} new-arrivals=${newArrivals.length} shelf=${shelf.length}`;

  const skipReasonBreakdown: Record<string, number> = Object.fromEntries(
    Object.entries(skips).filter(([, n]) => n > 0),
  );

  if (!live) {
    // DRY-RUN by default (the state-coverage-notify / LOSS_RECOVERY
    // precedent): the operator reads this exact plan, then flips the env.
    return {
      status: 'success',
      recordsTouched: 0,
      notes: `DRY-RUN (RANCH_STAND_DIGEST_ENABLED!=='true') — would send ${baseNote}`,
      skipReasonBreakdown,
    };
  }

  // ── Send loop — claim-before-send, durable Notes stamp after ──────────
  const monthKey = now.toISOString().slice(0, 7); // YYYY-MM
  const dayIso = now.toISOString().slice(0, 10);
  const notesById = new Map<string, string>();
  for (const c of consumers) notesById.set(String(c.id), String(c['Notes'] || ''));
  const stampNotes = async (consumerId: string, outcome: 'sent' | 'suppressed') => {
    const line = buildDigestMarkerLine(dayIso, outcome, tier);
    const existing = notesById.get(consumerId) || '';
    await updateRecord(TABLES.CONSUMERS, consumerId, {
      Notes: existing ? `${existing}\n${line}` : line,
    });
  };

  // One Email Sends read for the whole batch instead of 200 per-recipient
  // cap lookups (the scale-audit batch-prime pattern).
  await primeFrequencyCapCache(selected.map((t) => t.email));

  let sent = 0;
  let sendSuppressed = 0;
  let claimSkipped = 0;
  let deadlineExit = false;
  const errors: string[] = [];

  for (const t of selected) {
    if (Date.now() - runStartMs > SOFT_DEADLINE_MS) {
      // Exit honestly (the batch-approve lesson) — the unstamped tail stays
      // eligible and next month's window picks it up.
      deadlineExit = true;
      break;
    }
    try {
      // Same-run / racing-runs belt: one claim per (consumer, month). The
      // durable anchor is the Notes stamp below — claimOnce degrades OPEN.
      const won = await claimOnce(`ranch-stand-digest:${t.consumerId}:${monthKey}`, 40 * 24 * 60 * 60);
      if (!won) {
        claimSkipped++;
        continue;
      }
      const { subject, html } = renderRanchStandDigest({
        firstName: t.firstName,
        recipientState: t.state,
        servedStates,
        newArrivals: shownArrivals,
        shelf,
        latestClose,
        story,
        monthIndex: now.getUTCMonth(),
        siteUrl: SITE_URL,
      });
      const result = await sendRanchStandDigest({ to: t.email, subject, html });
      if (result?.success) {
        sent++;
        await stampNotes(t.consumerId, 'sent');
      } else {
        // Suppressed/failed at the send layer (3/week cap, suppression list,
        // Resend error). Stamp 'suppressed' so the cadence cap holds — a
        // recipient never burns more than one attempt per 25 days.
        sendSuppressed++;
        await stampNotes(t.consumerId, 'suppressed');
      }
      // Pace: stay friendly to the shared send gate + Airtable 5 req/s.
      await new Promise((r) => setTimeout(r, 400));
    } catch (e: any) {
      errors.push(`${t.consumerId}: ${String(e?.message || e).slice(0, 80)}`);
    }
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: sent,
    notes:
      `${baseNote} sent=${sent} send-suppressed=${sendSuppressed} claim-skipped=${claimSkipped} ` +
      `errs=${errors.length}${errors.length ? ' err1=' + errors[0] : ''}${deadlineExit ? ' DEADLINE-EXIT (tail waits for next month)' : ''}`,
    skipReasonBreakdown,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('ranch-stand-digest', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
