// app/api/cron/demand-router/route.ts
//
// THE DEMAND ROUTER — capacity-gated sender for the nationwide backfill
// campaign (docs/NATIONWIDE-2-RANCHER-CAMPAIGN.md + docs/CAMPAIGN-SENDS.md).
//
// Runs hourly (see vercel.json). Each run:
//   1. Reads open deposit slots per rancher (Foodstead=WEST, Silverline=EAST+
//      CENTRAL) from the canonical capacity helper.
//   2. Selects the next batch of highest-intent, not-yet-contacted-this-wave
//      buyers by coast → matching rancher, sized to min(daily cap, open slots ×
//      conversion buffer). Tier order: stranded-qualified → HOT → WARM.
//   3. Sends the buyer's current wave (Msg1 day0 / Msg2 +3 / Msg3 +7) — email
//      via lib/email (suppression + frequency-whitelist), SMS only to opted-in
//      consumers via sendSMSToConsumer (TCPA gate + STOP).
//   4. Stamps disposition (Campaign Stage + Last Sent + Rancher), waitlists
//      overflow demand by state, sunsets dead full-arc buyers.
//   5. Telegram report to Ben.
//
// ── NON-NEGOTIABLE SAFETY ────────────────────────────────────────────────
//  • DRY-RUN DEFAULT. Unless CAMPAIGN_LIVE === 'true', this does ALL selection
//    + renders every message + reports EXACTLY what it WOULD send, but sends
//    NOTHING and writes NO disposition. Ben reviews the dry-run, then flips the
//    flag. The plan (lib/demandRouter.buildCampaignPlan) is pure + deterministic
//    so the dry-run and the live run select identical buyers.
//  • KILL-SWITCH. CAMPAIGN_ROUTER_ENABLED must be 'true' or the cron no-ops
//    (even for dry-run). Belt to CAMPAIGN_LIVE's suspenders.
//  • CAPACITY-GATED. Never selects more than openSlots × buffer (proven in
//    lib/demandRouter.test.ts) — cannot oversell.
//  • IDEMPOTENT. Stage + last-sent dedupe; the stamp is written BEFORE the send
//    (claim-before-send) so a failed/again run never double-sends a wave.
//  • CRON_SECRET auth + maintenance gate + withCronRun (mirrors other crons).
//
// Mirrors app/api/cron/buyer-pulse/route.ts (auth, maintenance, withCronRun,
// sequential per-record try/catch, claim-before-send, Telegram digest).

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendDemandRouterCampaign } from '@/lib/email';
import { sendSMSToConsumer } from '@/lib/twilio';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { logAuditEntry } from '@/lib/auditLog';
import { getMaxActiveReferrals, getLiveCapacity } from '@/lib/rancherCapacity';
import {
  buildCampaignPlan,
  renderMessage,
  rancherPageUrl,
  openSlotsFor,
  CAMPAIGN_TEMPLATE_NAMES,
  CAMPAIGN_STAGE_FOR_WAVE,
  CAMPAIGN_NAME,
  FOODSTEAD,
  SILVERLINE,
  type CampaignBuyer,
  type PlannedSend,
  type CampaignPlan,
  type RancherTarget,
  type Wave,
} from '@/lib/demandRouter';

export const maxDuration = 180;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// ── Safety flags ─────────────────────────────────────────────────────────
// Kill-switch: the whole cron no-ops unless explicitly enabled.
function routerEnabled(): boolean {
  return process.env.CAMPAIGN_ROUTER_ENABLED === 'true';
}
// DRY-RUN default: only TRUE when the operator has explicitly armed live sends.
function isLive(): boolean {
  return process.env.CAMPAIGN_LIVE === 'true';
}
// SMS is double-gated: ENABLE_SMS env AND per-consumer SMS Opt-In (TCPA).
function smsEnabled(): boolean {
  return process.env.ENABLE_SMS === 'true';
}

interface CronResult {
  status: 'success' | 'partial' | 'error' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
}

/**
 * Resolve the buyer-facing reserve link for a planned send.
 *
 * Spec: personalize {link} with the 1-tap campaign link via
 * `mintCampaignReserveToken` IF that helper exists (feat/campaign-1tap-links);
 * if absent, fall back to the rancher page URL `/ranchers/<slug>`.
 *
 * On THIS branch (origin/main) that helper does not exist, so we use the
 * documented fallback. When feat/campaign-1tap-links merges, wire the 1-tap
 * mint here — flagged below so it's a one-line upgrade. We deliberately do NOT
 * attempt a dynamic import of a non-existent module (it can't resolve through
 * the build-time `@/` alias at runtime, and a fragile import is riskier than a
 * correct, honest fallback for a money-adjacent send path).
 */
async function resolveLink(rancher: RancherTarget, _send: PlannedSend): Promise<string> {
  // TODO(feat/campaign-1tap-links): when lib/campaignReserve.ts lands, mint a
  // per-buyer 1-tap token here and return `${SITE_URL}/r/${token}`.
  return rancherPageUrl(SITE_URL, rancher);
}

/**
 * Read open deposit slots per rancher from the canonical capacity helper.
 * openSlots = Max Active Referrals − live Current Active count (Redis-backed,
 * race-safe). Clamped >= 0. Returns the rancher records too (for max display).
 */
async function readCapacity(): Promise<{
  west: number;
  eastCentral: number;
  detail: { foodsteadMax: number; foodsteadCur: number; silverlineMax: number; silverlineCur: number };
}> {
  const [foodstead, silverline] = await Promise.all([
    getRecordById(TABLES.RANCHERS, FOODSTEAD.id).catch(() => null) as Promise<any>,
    getRecordById(TABLES.RANCHERS, SILVERLINE.id).catch(() => null) as Promise<any>,
  ]);
  const foodsteadMax = getMaxActiveReferrals(foodstead);
  const silverlineMax = getMaxActiveReferrals(silverline);
  const [foodsteadCur, silverlineCur] = await Promise.all([
    getLiveCapacity(FOODSTEAD.id).catch(() => Number(foodstead?.['Current Active Referrals'] || 0)),
    getLiveCapacity(SILVERLINE.id).catch(() => Number(silverline?.['Current Active Referrals'] || 0)),
  ]);
  return {
    west: openSlotsFor({ max: foodsteadMax, current: foodsteadCur }),
    eastCentral: openSlotsFor({ max: silverlineMax, current: silverlineCur }),
    detail: { foodsteadMax, foodsteadCur, silverlineMax, silverlineCur },
  };
}

/**
 * Pull the candidate buyer pool. We intentionally pull broadly (active-ish
 * consumers) and let the PURE planner do all suppression/tiering/gating — that
 * keeps the selection logic in one tested place. We exclude only the obvious
 * hard-suppressed at the Airtable layer to keep the payload small.
 */
async function readBuyers(): Promise<CampaignBuyer[]> {
  // Exclude unsubscribed/bounced/complained + already-sunset at the query layer
  // (cheap pre-filter). Everything else is decided by buildCampaignPlan.
  const formula =
    'AND(' +
    '{Email} != "", ' +
    'NOT({Unsubscribed} = TRUE()), ' +
    'NOT({Bounced} = TRUE()), ' +
    'NOT({Complained} = TRUE()), ' +
    'NOT({Campaign Stage} = "Sunset")' +
    ')';
  const rows = (await getAllRecords(TABLES.CONSUMERS, formula)) as any[];
  return rows.map((r) => ({ id: r.id, fields: r as Record<string, unknown> }));
}

// ── Disposition stamps (LIVE only) ─────────────────────────────────────────

async function stampSend(send: PlannedSend, now: Date): Promise<void> {
  const fields: Record<string, unknown> = {
    'Campaign Stage': CAMPAIGN_STAGE_FOR_WAVE[send.wave],
    'Campaign Last Sent At': now.toISOString(),
    'Campaign Rancher': [send.rancher.id],
  };
  await updateRecord(TABLES.CONSUMERS, send.buyerId, fields);
}

async function stampWaitlist(buyerId: string, state: string): Promise<void> {
  await updateRecord(TABLES.CONSUMERS, buyerId, { 'Campaign Waitlist State': state });
}

async function stampSunset(buyerId: string, now: Date): Promise<void> {
  await updateRecord(TABLES.CONSUMERS, buyerId, {
    'Campaign Stage': 'Sunset',
    'Campaign Sunset At': now.toISOString(),
  });
}

// ── Telegram report ─────────────────────────────────────────────────────────

function buildReport(plan: CampaignPlan, opts: {
  live: boolean;
  smsOn: boolean;
  capDetail: { foodsteadMax: number; foodsteadCur: number; silverlineMax: number; silverlineCur: number };
  smsPlanned: number;
  failures: string[];
}): string {
  const mode = opts.live ? '🟢 LIVE' : '🟡 DRY-RUN (nothing sent)';
  const d = opts.capDetail;
  const suppressedTotal = Object.values(plan.suppressed).reduce((a, b) => a + b, 0);
  const suppressedBreak = Object.entries(plan.suppressed)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}:${n}`)
    .join(' · ') || 'none';
  const waitlistBreak = Object.entries(plan.waitlistByState)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s}:${n}`)
    .join(' · ') || 'none';

  const lines: string[] = [
    `🐄 <b>DEMAND ROUTER</b> · ${mode}`,
    '',
    '<b>Capacity (open / cap)</b>',
    `• Foodstead (WEST): ${plan.capacity.west.open} open / ${d.foodsteadMax} cap → filling ${plan.capacity.west.planned}`,
    `• Silverline (EAST+CENTRAL): ${plan.capacity.eastCentral.open} open / ${d.silverlineMax} cap → filling ${plan.capacity.eastCentral.planned}`,
    '',
    '<b>Sends by wave</b>',
    `• Msg1: ${plan.byWave.Msg1} · Msg2: ${plan.byWave.Msg2} · Msg3: ${plan.byWave.Msg3}`,
    `• Total ${opts.live ? 'sent' : 'WOULD send'}: ${plan.sends.length} email${plan.sends.length === 1 ? '' : 's'}` +
      `${opts.smsOn ? ` + ${opts.smsPlanned} SMS` : ` (SMS off — ${opts.smsPlanned} opted-in skipped)`}`,
    '',
    `<b>Waitlisted by state:</b> ${plan.waitlist.length} (${waitlistBreak})`,
    `<b>Sunset (full arc, no engagement):</b> ${plan.sunset.length}`,
    `<b>Suppressed:</b> ${suppressedTotal} (${suppressedBreak})`,
  ];
  if (opts.failures.length > 0) {
    lines.push('', '<b>Failures:</b>', ...opts.failures.slice(0, 8).map((f) => `• ${f}`));
  }
  if (!opts.live) {
    lines.push('', '<i>Set CAMPAIGN_LIVE=true to arm. Review the plan above first.</i>');
  }
  return lines.join('\n');
}

// ── Per-send execution (LIVE) ────────────────────────────────────────────────

async function executeSend(
  send: PlannedSend,
  now: Date,
  smsOn: boolean,
  failures: string[],
): Promise<{ emailOk: boolean; smsOk: boolean }> {
  let emailOk = false;
  let smsOk = false;

  // RENDER FIRST (pure, no side effects). Doing this BEFORE the claim-stamp
  // means a render/link failure aborts WITHOUT consuming the wave — otherwise a
  // throw here would leave the stage stamped but nothing sent, silently
  // skipping the wave forever. Render can't have side effects, so it's safe to
  // precede the claim.
  let msg: ReturnType<typeof renderMessage>;
  try {
    const link = await resolveLink(send.rancher, send);
    msg = renderMessage(send.wave, {
      firstName: send.firstName,
      state: send.state,
      rancher: send.rancher,
      link,
    });
  } catch (e: any) {
    failures.push(`${send.email}: render failed, NOT stamped/sent — ${e?.message || 'unknown'}`);
    return { emailOk: false, smsOk: false };
  }

  // CLAIM BEFORE SEND (idempotency): stamp the stage + last-sent BEFORE the
  // actual send so a crash/timeout after this point can never re-send the same
  // wave on the next run (the wave-gap dedupe in decideWave keys off exactly
  // these fields). If the stamp itself fails we SKIP the send entirely (better
  // a missed wave than a double-send) and surface it.
  try {
    await stampSend(send, now);
  } catch (e: any) {
    failures.push(`${send.email}: stamp failed, send SKIPPED — ${e?.message || 'unknown'}`);
    return { emailOk: false, smsOk: false };
  }

  // EMAIL — suppression + frequency-whitelist handled inside the sender.
  try {
    const res = await sendDemandRouterCampaign({
      email: send.email,
      subject: msg.subject,
      html: msg.html,
      templateName: CAMPAIGN_TEMPLATE_NAMES[send.wave],
      recipientConsumerId: send.buyerId,
      replyConsumerId: send.buyerId,
      campaign: CAMPAIGN_NAME,
    });
    emailOk = !!res?.success;
    if (res?.suppressed) {
      failures.push(`${send.email}: email suppressed — ${res.reason || 'unknown'}`);
    }
  } catch (e: any) {
    failures.push(`${send.email}: email failed — ${e?.message || 'unknown'}`);
  }

  // SMS — opt-in only (TCPA). Double-gated: ENABLE_SMS + sendSMSToConsumer's
  // own SMS Opt-In/Unsubscribed checks. Only waves with an SMS variant + an
  // opted-in buyer were planned (send.sms === true). Fire-and-forget style but
  // awaited so the report count is accurate.
  if (smsOn && send.sms && msg.sms) {
    try {
      const buyer = (await getRecordById(TABLES.CONSUMERS, send.buyerId)) as any;
      smsOk = await sendSMSToConsumer({
        consumer: buyer,
        body: msg.sms,
        reason: `demand-router ${send.wave}`,
      });
    } catch (e: any) {
      failures.push(`${send.email}: sms failed — ${e?.message || 'unknown'}`);
    }
  }

  // Audit (best-effort, reversible stamp).
  try {
    await logAuditEntry({
      actor: 'cron',
      tool: 'demand-router',
      targetType: 'Consumer',
      targetId: send.buyerId,
      args: { wave: send.wave, rancher: send.rancher.slug, email: send.email, sms: send.sms && smsOn },
      result: { emailOk, smsOk },
      reverseAction: {
        type: 'airtable-update',
        table: TABLES.CONSUMERS,
        recordId: send.buyerId,
        // Restore prior campaign state. We can't un-send an email; this reverts
        // the disposition so a re-run would re-evaluate the wave.
        fields: { 'Campaign Stage': null, 'Campaign Last Sent At': null },
      },
    });
  } catch {
    /* non-fatal */
  }

  return { emailOk, smsOk };
}

// ── Handler ─────────────────────────────────────────────────────────────────

async function realHandler(_request: Request): Promise<CronResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  // KILL-SWITCH — no-op (success row) unless explicitly enabled. Ships inert.
  if (!routerEnabled()) {
    return {
      status: 'success',
      recordsTouched: 0,
      notes: 'no-op: CAMPAIGN_ROUTER_ENABLED !== "true" (kill-switch off)',
    };
  }

  const live = isLive();
  const smsOn = smsEnabled();
  const now = new Date();
  const nowMs = now.getTime();

  // 1. Capacity + 2. buyers (parallel reads).
  const [cap, buyers] = await Promise.all([readCapacity(), readBuyers()]);

  // 3. PURE PLAN — selection + tiering + capacity gating + wave decisions +
  // suppression + sunset. No side effects.
  const plan = buildCampaignPlan(buyers, {
    now: nowMs,
    capacity: { west: cap.west, eastCentral: cap.eastCentral },
    dailyCap: Number(process.env.CAMPAIGN_DAILY_CAP || 25),
    conversionBuffer: Number(process.env.CAMPAIGN_CONVERSION_BUFFER || 3),
  });

  const smsPlanned = plan.sends.filter((s) => s.sms).length;
  const failures: string[] = [];
  let emailsSent = 0;
  let smsSent = 0;
  let waitlisted = 0;
  let sunsetted = 0;

  if (live) {
    // ── EXECUTE: sends (with claim-before-send), waitlist, sunset stamps. ──
    for (const send of plan.sends) {
      try {
        const result = await executeSend(send, now, smsOn, failures);
        if (result.emailOk) emailsSent++;
        if (result.smsOk) smsSent++;
        // Gentle pace between sends (deliverability) — the email lib also rate-
        // limits internally, this just spreads the loop.
        await new Promise((resolve) => setTimeout(resolve, 250));
      } catch (e: any) {
        failures.push(`${send.email}: send loop error — ${e?.message || 'unknown'}`);
      }
    }
    for (const w of plan.waitlist) {
      try {
        await stampWaitlist(w.buyerId, w.state);
        waitlisted++;
      } catch (e: any) {
        failures.push(`waitlist ${w.buyerId}: ${e?.message || 'unknown'}`);
      }
    }
    for (const s of plan.sunset) {
      try {
        await stampSunset(s.buyerId, now);
        sunsetted++;
      } catch (e: any) {
        failures.push(`sunset ${s.buyerId}: ${e?.message || 'unknown'}`);
      }
    }
  }
  // DRY-RUN: do nothing — no sends, no stamps. The report shows the full plan.

  // 5. Telegram report (always — dry-run reports the plan; live reports results).
  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      buildReport(plan, { live, smsOn, capDetail: cap.detail, smsPlanned, failures }),
    );
  } catch {
    /* non-fatal */
  }

  const recordsTouched = live ? emailsSent + waitlisted + sunsetted : 0;
  const status: CronResult['status'] = failures.length > 0 ? 'partial' : 'success';
  const planned = plan.sends.length;
  const notes = live
    ? `LIVE sent=${emailsSent}/${planned} sms=${smsSent}/${smsPlanned} waitlist=${waitlisted} sunset=${sunsetted} suppressed=${Object.values(plan.suppressed).reduce((a, b) => a + b, 0)} failures=${failures.length} (slots W=${cap.west} E/C=${cap.eastCentral})`
    : `DRY-RUN would-send=${planned} email +${smsPlanned} sms · waitlist=${plan.waitlist.length} sunset=${plan.sunset.length} suppressed=${Object.values(plan.suppressed).reduce((a, b) => a + b, 0)} (slots W=${cap.west} E/C=${cap.eastCentral}) — set CAMPAIGN_LIVE=true to arm`;

  return { status, recordsTouched, notes };
}

async function authedHandler(request: Request): Promise<Response> {
  const { CRON_SECRET } = await import('@/lib/secrets');
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    const url = new URL(request.url);
    const secret = url.searchParams.get('secret');
    if (secret !== CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  return withCronRun('demand-router', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
