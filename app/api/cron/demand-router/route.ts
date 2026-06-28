// app/api/cron/demand-router/route.ts
//
// THE DEMAND ROUTER — capacity-gated sender for the nationwide backfill
// campaign (docs/NATIONWIDE-2-RANCHER-CAMPAIGN.md + docs/CAMPAIGN-SENDS.md),
// now a COMBINED email+SMS, send-time-gated, recovery-aware flow.
//
// Runs hourly (see vercel.json). Each run:
//   1. Reads open deposit slots per rancher (Foodstead=WEST, Silverline=EAST+
//      CENTRAL) from the canonical capacity helper.
//   2. [Upgrade B] Counts reservations that paid a deposit in the last 7 days →
//      a live social-proof line injected into Msg2/Msg3 (omitted below a floor).
//   3. Selects the next batch of highest-intent, not-yet-contacted-this-wave
//      buyers by coast → matching rancher, sized to min(daily cap, open slots ×
//      conversion buffer). Tier order: stranded-qualified → HOT → WARM. The arc
//      is EMAIL-LED (planner smsWaves disabled — SMS is a recovery touch, below).
//   4. Sends the buyer's current wave (Msg1 day0 / Msg2 +3 / Msg3 +7) by EMAIL
//      via lib/email — but only inside the EMAIL send-window for the buyer's
//      local time [Upgrade C]; out-of-window sends DEFER to a later hourly run.
//   5. [Upgrade C] SMS RECOVERY: opted-in buyers emailed ≥8h ago who haven't
//      converted get ONE short, DISTINCT recovery SMS (different angle), gated to
//      the SMS send-window + TCPA, stamped on Campaign SMS Recovery Sent At.
//   6. [Upgrade A] ABANDONED-RESERVE RECOVERY: buyers who created a reserve
//      referral but never paid the deposit get a recovery EMAIL ("your {cut}
//      share is still held →"), then a recovery SMS if still unconverted —
//      stamped on Reserve Recovery Sent At / Reserve Recovery SMS Sent At.
//   7. Stamps disposition, waitlists overflow demand by state, sunsets dead
//      full-arc buyers, Telegram report to Ben.
//
// ── NON-NEGOTIABLE SAFETY (unchanged) ─────────────────────────────────────
//  • DRY-RUN DEFAULT. Unless CAMPAIGN_LIVE === 'true', this does ALL selection
//    + renders every message + reports EXACTLY what it WOULD send/recover, but
//    sends NOTHING and writes NO disposition. Applies to the backfill arc, the
//    SMS recovery, AND the abandoned-reserve recovery.
//  • KILL-SWITCH. CAMPAIGN_ROUTER_ENABLED must be 'true' or the cron no-ops.
//  • CAPACITY-GATED. Never selects more than openSlots × buffer. (Recovery is
//    NOT capacity-gated by design — those buyers already hold a reserve slot.)
//  • IDEMPOTENT. Stage/last-sent dedupe + recovery stamps written BEFORE the
//    send (claim-before-send) so a failed/again run never double-sends.
//  • TCPA. Every SMS is opt-in-gated (planner/selector + sendSMSToConsumer) and
//    double-gated by ENABLE_SMS; SMS only fires inside the SMS send-window.
//  • CRON_SECRET auth + maintenance gate + withCronRun (mirrors other crons).
//
// Mirrors app/api/cron/buyer-pulse + deposit-accept-sla (auth, maintenance,
// withCronRun, sequential per-record try/catch, stamp-before-side-effect).

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendDemandRouterCampaign } from '@/lib/email';
import { sendSMSToConsumer } from '@/lib/twilio';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { logAuditEntry } from '@/lib/auditLog';
import { getMaxActiveReferrals, getLiveCapacity } from '@/lib/rancherCapacity';
import { mintCampaignReserveToken } from '@/lib/campaignReserve';
import { type Cut } from '@/lib/reserveDeposit';
import {
  buildCampaignPlan,
  renderMessage,
  renderSmsRecovery,
  rancherPageUrl,
  rancherForState,
  openSlotsFor,
  countRecentDeposits,
  socialProofLine,
  isSmsRecoveryEligible,
  CAMPAIGN_TEMPLATE_NAMES,
  CAMPAIGN_STAGE_FOR_WAVE,
  CAMPAIGN_NAME,
  SMS_RECOVERY_CAMPAIGN_NAME,
  CAMPAIGN_SMS_RECOVERY_FIELD,
  DEFAULT_SMS_RECOVERY_HOURS,
  SOCIAL_PROOF_DAYS,
  FOODSTEAD,
  SILVERLINE,
  type CampaignBuyer,
  type PlannedSend,
  type CampaignPlan,
  type RancherTarget,
  type Wave,
} from '@/lib/demandRouter';
import { isEmailWindow, isSmsWindow } from '@/lib/sendWindow';
import { normalizeState } from '@/lib/states';
import {
  selectRecoveryEmail,
  selectRecoverySms,
  renderRecoveryEmail,
  renderRecoverySms,
  DEFAULT_RESERVE_RECOVERY_HOURS,
  DEFAULT_RESERVE_RECOVERY_SMS_HOURS,
  RECOVERY_CAMPAIGN_NAME,
  RECOVERY_EMAIL_TEMPLATE,
  RESERVE_RECOVERY_EMAIL_FIELD,
  RESERVE_RECOVERY_SMS_FIELD,
  type RecoveryReferralLike,
} from '@/lib/reserveRecovery';

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
 * Resolve the buyer-facing {link} for a planned send.
 *
 * Personalizes the 1-tap deposit link via mintCampaignReserveToken (#122):
 * a scoped token pinning {consumerId, rancherSlug, cut} → /r/d/<token>, which
 * the /r/d route exchanges for a cut-prefilled deposit checkout (eligibility-
 * gated server-side). Falls back to the rancher's public page `/ranchers/<slug>`
 * ONLY if minting can't proceed — i.e. the buyer has no usable cut (Order Type
 * blank/"Not Sure") or mint throws (mint requires a valid cut + slug). The
 * fallback keeps the campaign honest for buyers we can't 1-tap.
 */
async function resolveLink(rancher: RancherTarget, send: PlannedSend): Promise<string> {
  const base = SITE_URL.replace(/\/+$/, '');
  if (send.cut) {
    try {
      const token = mintCampaignReserveToken({
        consumerId: send.buyerId,
        rancherSlug: rancher.slug,
        cut: send.cut,
      });
      if (token) return `${base}/r/d/${token}`;
    } catch (e: any) {
      // mint throws on a bad cut/slug — fall back rather than ship a broken link.
      console.warn(`[demand-router] mint failed for ${send.buyerId}, using rancher-page fallback:`, e?.message);
    }
  }
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
  degraded: string[];
}> {
  const [foodstead, silverline] = await Promise.all([
    getRecordById(TABLES.RANCHERS, FOODSTEAD.id).catch(() => null) as Promise<any>,
    getRecordById(TABLES.RANCHERS, SILVERLINE.id).catch(() => null) as Promise<any>,
  ]);

  // FAIL-CLOSED on a missing/failed rancher record. getMaxActiveReferrals(null)
  // returns DEFAULT_MAX=5 — a transient fetch failure would otherwise INVENT 5
  // open slots and trigger unintended live sends. For a money-adjacent sender we
  // must never fabricate capacity: a null record → 0 slots for that coast (skip
  // it this run). The `degraded` list surfaces the skip in the report.
  const degraded: string[] = [];

  async function coastSlots(
    rec: any,
    rancherId: string,
    label: string,
  ): Promise<{ open: number; max: number; cur: number }> {
    if (!rec) {
      degraded.push(`${label}: rancher record unavailable → capacity forced to 0 (skipped)`);
      return { open: 0, max: 0, cur: 0 };
    }
    const max = getMaxActiveReferrals(rec);
    const cur = await getLiveCapacity(rancherId).catch(
      () => Number(rec?.['Current Active Referrals'] || 0),
    );
    return { open: openSlotsFor({ max, current: cur }), max, cur };
  }

  const [fs, sl] = await Promise.all([
    coastSlots(foodstead, FOODSTEAD.id, 'Foodstead (WEST)'),
    coastSlots(silverline, SILVERLINE.id, 'Silverline (EAST+CENTRAL)'),
  ]);

  return {
    west: fs.open,
    eastCentral: sl.open,
    detail: {
      foodsteadMax: fs.max,
      foodsteadCur: fs.cur,
      silverlineMax: sl.max,
      silverlineCur: sl.cur,
    },
    degraded,
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
  failures: string[];
  degraded: string[];
  emailsDeferred: number;
  proof: SocialProof;
  smsRec: { planned: number; sent: number; deferred: number };
  recovery: {
    emailPlanned: number;
    emailSent: number;
    emailDeferred: number;
    smsPlanned: number;
    smsSent: number;
    smsDeferred: number;
  };
}): string {
  const mode = opts.live ? '🟢 LIVE' : '🟡 DRY-RUN (nothing sent)';
  const d = opts.capDetail;
  const w = plan.capacity.west;
  const ec = plan.capacity.eastCentral;
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
    `🐄 <b>DEMAND ROUTER</b> · ${mode} · combined email+SMS`,
    '',
    '<b>Capacity</b> (open slots / cap · outstanding-invited / new-invite budget)',
    `• Foodstead (WEST): ${w.open} open / ${d.foodsteadMax} cap · ${w.outstanding} out / ${w.newBudget} new-budget → filling ${w.planned}`,
    `• Silverline (EAST+CENTRAL): ${ec.open} open / ${d.silverlineMax} cap · ${ec.outstanding} out / ${ec.newBudget} new-budget → filling ${ec.planned}`,
  ];
  if (opts.degraded.length > 0) {
    lines.push('', '⚠️ <b>Capacity degraded (fail-closed):</b>', ...opts.degraded.map((g) => `• ${g}`));
  }
  // Upgrade B — social proof shown (or omitted) this run.
  const proofShown = opts.proof.overall
    ? `“${opts.proof.overall}”`
    : 'omitted (below floor — never shows a weak number)';
  lines.push(
    '',
    '<b>Backfill arc (email-led)</b>',
    `• Msg1 (new): ${plan.byWave.Msg1} · Msg2: ${plan.byWave.Msg2} · Msg3: ${plan.byWave.Msg3}`,
    `• Email ${opts.live ? 'sent' : 'WOULD send'}: ${plan.sends.length}` +
      `${opts.emailsDeferred > 0 ? ` (${opts.emailsDeferred} deferred — outside send-window)` : ''}`,
    `• Social proof: ${proofShown}`,
    '',
    '<b>SMS recovery</b> (opted-in, emailed ≥8h ago, unconverted — distinct angle)',
    `• ${opts.live ? 'sent' : 'WOULD send'}: ${opts.smsRec.sent}/${opts.smsRec.planned}` +
      `${opts.smsRec.deferred > 0 ? ` (${opts.smsRec.deferred} deferred — outside SMS window)` : ''}` +
      `${opts.smsOn ? '' : ' · ENABLE_SMS off'}`,
    '',
    '<b>Abandoned-reserve recovery</b> (reserved, never deposited — highest ROI)',
    `• Email: ${opts.recovery.emailSent}/${opts.recovery.emailPlanned}` +
      `${opts.recovery.emailDeferred > 0 ? ` (${opts.recovery.emailDeferred} deferred)` : ''}`,
    `• SMS: ${opts.recovery.smsSent}/${opts.recovery.smsPlanned}` +
      `${opts.recovery.smsDeferred > 0 ? ` (${opts.recovery.smsDeferred} deferred)` : ''}` +
      `${opts.smsOn ? '' : ' · ENABLE_SMS off'}`,
    '',
    `<b>Waitlisted by state:</b> ${plan.waitlist.length} (${waitlistBreak})`,
    `<b>Sunset (full arc, no engagement):</b> ${plan.sunset.length}`,
    `<b>Suppressed:</b> ${suppressedTotal} (${suppressedBreak})`,
  );
  if (opts.failures.length > 0) {
    lines.push('', '<b>Failures:</b>', ...opts.failures.slice(0, 8).map((f) => `• ${f}`));
  }
  if (!opts.live) {
    lines.push('', '<i>Set CAMPAIGN_LIVE=true to arm. Review the plan above first.</i>');
  }
  return lines.join('\n');
}

// ── Per-send execution (LIVE) — EMAIL-LED backfill wave ──────────────────────
//
// Returns deferred:true (Upgrade C) when the buyer is OUTSIDE their local email
// send-window — we then leave the wave stamp UNTOUCHED so a later in-window
// hourly run picks them up (the send is deferred, never dropped).

async function executeSend(
  send: PlannedSend,
  now: Date,
  socialProof: string,
  failures: string[],
): Promise<{ emailOk: boolean; deferred: boolean }> {
  let emailOk = false;

  // SEND-WINDOW GATE (Upgrade C) — BEFORE render/claim so a deferred send
  // consumes nothing: no stamp, no wave advance. The next hourly run that lands
  // inside the buyer's local email window will send it. EMAIL window ~9-11am +
  // mid-afternoon, never overnight (env-tunable). Buyer-local via state→tz.
  if (!isEmailWindow(send.state, now.getTime())) {
    return { emailOk: false, deferred: true };
  }

  // RENDER FIRST (pure, no side effects). Doing this BEFORE the claim-stamp
  // means a render/link failure aborts WITHOUT consuming the wave — otherwise a
  // throw here would leave the stage stamped but nothing sent, silently
  // skipping the wave forever. Render can't have side effects, so it's safe to
  // precede the claim. Msg2/Msg3 carry the live {socialProof} line (Upgrade B).
  let msg: ReturnType<typeof renderMessage>;
  try {
    const link = await resolveLink(send.rancher, send);
    msg = renderMessage(send.wave, {
      firstName: send.firstName,
      state: send.state,
      rancher: send.rancher,
      link,
      socialProof,
    });
  } catch (e: any) {
    failures.push(`${send.email}: render failed, NOT stamped/sent — ${e?.message || 'unknown'}`);
    return { emailOk: false, deferred: false };
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
    return { emailOk: false, deferred: false };
  }

  // EMAIL — suppression + frequency-whitelist handled inside the sender. SMS is
  // NOT sent here: the arc is email-led and SMS is a LATER recovery touch
  // (runSmsRecovery) per the research, so a buyer never gets a simultaneous
  // email+SMS blast.
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

  // Audit (best-effort, reversible stamp).
  try {
    await logAuditEntry({
      actor: 'cron',
      tool: 'demand-router',
      targetType: 'Consumer',
      targetId: send.buyerId,
      args: { wave: send.wave, rancher: send.rancher.slug, email: send.email },
      result: { emailOk },
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

  return { emailOk, deferred: false };
}

// ── Upgrade B: live social proof ─────────────────────────────────────────────
//
// Count reservations that paid a deposit in the last SOCIAL_PROOF_DAYS days
// (overall + per the two campaign ranchers, cheap because we already hold the
// rows). Returns pre-formatted lines (or '' to omit). We read the Referrals once
// with a CREATED-agnostic Deposit-Paid filter; the pure counter does the window.
interface SocialProof {
  overall: string;
  byRancher: Record<string, string>; // rancherId → line ('' when below floor)
}

async function readSocialProof(nowMs: number): Promise<SocialProof> {
  let rows: Array<Record<string, unknown>> = [];
  try {
    // Pull referrals with a non-empty Deposit Paid At in the window. We filter to
    // the window in the formula too (cheap server-side narrowing) but the pure
    // countRecentDeposits re-applies it deterministically.
    const sinceIso = new Date(nowMs - SOCIAL_PROOF_DAYS * 24 * 60 * 60 * 1000).toISOString();
    rows = (await getAllRecords(
      TABLES.REFERRALS,
      `AND({Deposit Paid At} != '', IS_AFTER({Deposit Paid At}, '${sinceIso}'))`,
    )) as Array<Record<string, unknown>>;
  } catch (e: any) {
    // Non-fatal: social proof is additive. On a read failure we OMIT it (no line)
    // rather than block the campaign.
    console.warn('[demand-router] social-proof read failed (omitting):', e?.message);
    return { overall: '', byRancher: {} };
  }
  const overallN = countRecentDeposits(rows, nowMs, { days: SOCIAL_PROOF_DAYS });
  const fsN = countRecentDeposits(rows, nowMs, { days: SOCIAL_PROOF_DAYS, rancherId: FOODSTEAD.id });
  const slN = countRecentDeposits(rows, nowMs, { days: SOCIAL_PROOF_DAYS, rancherId: SILVERLINE.id });
  return {
    overall: socialProofLine(overallN),
    byRancher: {
      [FOODSTEAD.id]: socialProofLine(fsN),
      [SILVERLINE.id]: socialProofLine(slN),
    },
  };
}

/**
 * Pick the social-proof line for a send: prefer the buyer's matched rancher's
 * own recent count (more credible), else fall back to the overall count. Either
 * may be '' (omit) — and the renderer collapses the line cleanly.
 */
function proofForRancher(proof: SocialProof, rancherId: string): string {
  return proof.byRancher[rancherId] || proof.overall || '';
}

// ── Upgrade C: SMS recovery pass (backfill arc) ──────────────────────────────
//
// A SEPARATE, LATER SMS touch for opted-in buyers the campaign emailed ≥N hours
// ago who haven't converted (research: SMS recovers an unengaged email). ONE
// distinct SMS per buyer, gated to the SMS send-window + TCPA, stamped on
// Campaign SMS Recovery Sent At. Capacity-free (these buyers were already
// email-selected within capacity).
async function runSmsRecovery(
  buyers: CampaignBuyer[],
  now: Date,
  live: boolean,
  smsOn: boolean,
  proof: SocialProof,
  failures: string[],
): Promise<{ planned: number; sent: number; deferred: number }> {
  const nowMs = now.getTime();
  const smsRecoveryHours = Number(process.env.CAMPAIGN_SMS_RECOVERY_HOURS || DEFAULT_SMS_RECOVERY_HOURS);

  // Pure eligibility: opted-in, emailed ≥N h ago, in-arc, unconverted, not yet
  // SMS-recovered. Then require a routable state (for the link's rancher + tz).
  const eligible = buyers.filter((b) =>
    isSmsRecoveryEligible(b.fields, nowMs, { smsRecoveryHours }),
  );

  let planned = 0;
  let sent = 0;
  let deferred = 0;

  for (const b of eligible) {
    const f = b.fields;
    const rancher = rancherForState(f['State']);
    if (!rancher) continue; // unroutable → can't build a link
    planned++;

    // SMS SEND-WINDOW gate (Upgrade C) — defer (no stamp) if outside the local
    // SMS window (weekday 9-12 / 5-7pm, never overnight). Picked up next run.
    if (!isSmsWindow(f['State'], nowMs)) {
      deferred++;
      continue;
    }
    if (!live) continue; // dry-run: counted as planned, nothing sent/stamped

    // Build the 1-tap link (same resolver as the email arc).
    const cut = cutLabelToCut(f['Order Type']);
    const fakeSend: PlannedSend = {
      buyerId: b.id,
      email: String(f['Email'] || ''),
      firstName: String(f['Full Name'] || '').trim().split(/\s+/)[0] || 'there',
      state: normalizeState(f['State']),
      coast: 'CENTRAL', // unused for link
      rancher,
      tier: 'warm', // unused
      wave: 'Msg2', // unused
      sms: true,
      phone: String(f['Phone'] || '').trim(),
      cut,
    };
    let link: string;
    try {
      link = await resolveLink(rancher, fakeSend);
    } catch {
      link = rancherPageUrl(SITE_URL, rancher);
    }

    const body = renderSmsRecovery({
      firstName: fakeSend.firstName,
      state: fakeSend.state,
      rancher,
      link,
      socialProof: proofForRancher(proof, rancher.id),
    });

    // CLAIM BEFORE SEND — stamp the SMS-recovery field first so a crash can't
    // re-send. If the stamp fails, skip (better a missed SMS than a double).
    try {
      await updateRecord(TABLES.CONSUMERS, b.id, {
        [CAMPAIGN_SMS_RECOVERY_FIELD]: now.toISOString(),
      });
    } catch (e: any) {
      failures.push(`sms-recovery ${b.id}: stamp failed, skipped — ${e?.message?.slice(0, 80) || 'unknown'}`);
      continue;
    }

    if (!smsOn) continue; // ENABLE_SMS off → stamped (so we don't re-plan) but not sent
    try {
      const ok = await sendSMSToConsumer({
        consumer: f as Record<string, any>,
        body,
        reason: 'demand-router sms-recovery',
      });
      if (ok) sent++;
    } catch (e: any) {
      failures.push(`sms-recovery ${b.id}: send failed — ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { planned, sent, deferred };
}

// ── Upgrade A: abandoned-reserve recovery pass ───────────────────────────────
//
// Buyers who created a reserve referral but never paid the deposit = the hottest
// recoverable cohort. Two idempotent steps (both stamp BEFORE the side effect):
//   • recovery EMAIL — "your {cut} share is still held →" + the 1-tap link.
//   • recovery SMS   — later, if still unconverted + opted-in (different angle).
// NOT capacity-gated: the buyer already holds a reserve slot. Send-window gated.
interface RecoveryRow extends RecoveryReferralLike {
  id: string;
  Rancher?: unknown;
  'Suggested Rancher'?: unknown;
  'Buyer Email'?: unknown;
  'Buyer Name'?: unknown;
  'Buyer State'?: unknown;
  'Order Type'?: unknown;
  Buyer?: unknown;
}

async function readRecoveryReferrals(nowMs: number): Promise<RecoveryRow[]> {
  // Pull deposit-intent referrals that have NOT paid a deposit. Keep the formula
  // permissive (the pure selector enforces status/refund/age) and refund-field-
  // free (mirrors deposit-accept-sla: {Refunded At} may not exist on Referrals,
  // and an unknown field errors the whole query).
  let rows: RecoveryRow[] = [];
  try {
    rows = (await getAllRecords(
      TABLES.REFERRALS,
      `AND({Deposit Paid At} = '', FIND('Deposit', {Match Type} & ''))`,
    )) as RecoveryRow[];
  } catch (e: any) {
    console.warn('[demand-router] recovery referral read failed:', e?.message);
    return [];
  }

  // Enrich with the linked Payments row (authoritative refund/dispute signal),
  // exactly like deposit-accept-sla — only for rows that survive the cheap age +
  // status pre-filter so we don't N+1 the whole table.
  const recoveryHours = Number(process.env.RESERVE_RECOVERY_HOURS || DEFAULT_RESERVE_RECOVERY_HOURS);
  const ageCutoff = nowMs - recoveryHours * 60 * 60 * 1000;
  const prelim = rows.filter((r) => {
    const created = r._createdTime ? new Date(String(r._createdTime)).getTime() : 0;
    return created > 0 && created <= ageCutoff; // old enough to consider
  });
  for (const ref of prelim) {
    try {
      const safeId = String(ref.id).replace(/"/g, '\\"');
      const payments = (await getAllRecords(
        TABLES.PAYMENTS,
        `SEARCH("${safeId}", ARRAYJOIN({Referral}))`,
      )) as any[];
      ref.__payment =
        payments.find(
          (p) =>
            p['Refunded At'] ||
            String(p['Status'] || '').toLowerCase() === 'refunded' ||
            String(p['Dispute Status'] || '').trim(),
        ) || payments[0] || null;
    } catch {
      ref.__payment = null;
    }
  }
  return prelim;
}

// Resolve the rancher (id + slug + name) a recovery referral points at — needed
// for the 1-tap link + copy. Reads the linked Rancher record's Slug/Name.
async function rancherForReferral(
  ref: RecoveryRow,
): Promise<{ id: string; slug: string; name: string } | null> {
  const links = (ref.Rancher || ref['Suggested Rancher']) as unknown;
  const ids = Array.isArray(links) ? links.map(String) : [];
  const id = ids[0];
  if (!id) return null;
  try {
    const rec = (await getRecordById(TABLES.RANCHERS, id)) as any;
    if (!rec) return null;
    const slug = String(rec['Slug'] || '').trim();
    const name = String(rec['Operator Name'] || rec['Ranch Name'] || 'your rancher').trim();
    if (!slug) return null; // no slug → can't mint a 1-tap link; skip recovery
    return { id, slug, name };
  } catch {
    return null;
  }
}

function cutLabelToCut(orderType: unknown): Cut | null {
  const raw = String(orderType || '').trim().toLowerCase();
  if (!raw) return null;
  const first = raw.split(/\s+/)[0];
  if (first === 'quarter' || first === 'half' || first === 'whole') return first as Cut;
  return null;
}

/** Build the 1-tap recovery link for a referral (token → /r/d/<token>), with
 * a rancher-page fallback when the buyer's cut is unknown or minting fails. */
function recoveryLink(
  consumerId: string,
  rancher: { slug: string },
  cut: Cut | null,
): string {
  const base = SITE_URL.replace(/\/+$/, '');
  if (cut && consumerId) {
    try {
      const token = mintCampaignReserveToken({ consumerId, rancherSlug: rancher.slug, cut });
      if (token) return `${base}/r/d/${token}`;
    } catch {
      /* fall through to rancher page */
    }
  }
  return `${base}/ranchers/${rancher.slug}`;
}

async function runReserveRecovery(
  now: Date,
  live: boolean,
  smsOn: boolean,
  proof: SocialProof,
  failures: string[],
): Promise<{
  emailPlanned: number;
  emailSent: number;
  emailDeferred: number;
  smsPlanned: number;
  smsSent: number;
  smsDeferred: number;
}> {
  const nowMs = now.getTime();
  const recoveryHours = Number(process.env.RESERVE_RECOVERY_HOURS || DEFAULT_RESERVE_RECOVERY_HOURS);
  const smsHours = Number(process.env.RESERVE_RECOVERY_SMS_HOURS || DEFAULT_RESERVE_RECOVERY_SMS_HOURS);
  const opts = { now: nowMs, recoveryHours, smsHours };

  const rows = await readRecoveryReferrals(nowMs);
  const emailEligible = selectRecoveryEmail(rows, opts);
  const smsEligible = selectRecoverySms(rows, opts);

  let emailPlanned = 0;
  let emailSent = 0;
  let emailDeferred = 0;
  let smsPlanned = 0;
  let smsSent = 0;
  let smsDeferred = 0;

  // ── Recovery EMAIL ──
  for (const ref of emailEligible) {
    const rancher = await rancherForReferral(ref);
    if (!rancher) continue;
    const consumerLinks = ref.Buyer as unknown;
    const consumerId = Array.isArray(consumerLinks) ? String(consumerLinks[0] || '') : '';
    const email = String(ref['Buyer Email'] || '').trim();
    if (!email) continue;
    const state = ref['Buyer State'];
    emailPlanned++;

    // EMAIL send-window gate — defer (no stamp) outside the local email window.
    if (!isEmailWindow(state, nowMs)) {
      emailDeferred++;
      continue;
    }
    if (!live) continue;

    const cut = cutLabelToCut(ref['Order Type']);
    const link = recoveryLink(consumerId, rancher, cut);
    const firstName = String(ref['Buyer Name'] || email).trim().split(/[ @]/)[0] || 'there';
    const msg = renderRecoveryEmail({
      firstName,
      cut: cut || 'beef',
      rancher: rancher.name,
      link,
      socialProof: proofForRancher(proof, rancher.id),
    });

    // CLAIM BEFORE SEND — stamp the recovery field first (idempotent).
    try {
      await updateRecord(TABLES.REFERRALS, ref.id, {
        [RESERVE_RECOVERY_EMAIL_FIELD]: now.toISOString(),
      });
    } catch (e: any) {
      failures.push(`reserve-recovery-email ${ref.id}: stamp failed, skipped — ${e?.message?.slice(0, 80) || 'unknown'}`);
      continue;
    }
    try {
      const res = await sendDemandRouterCampaign({
        email,
        subject: msg.subject,
        html: msg.html,
        templateName: RECOVERY_EMAIL_TEMPLATE,
        recipientConsumerId: consumerId || undefined,
        replyConsumerId: consumerId || undefined,
        campaign: RECOVERY_CAMPAIGN_NAME,
      });
      if (res?.success) emailSent++;
      if (res?.suppressed) failures.push(`reserve-recovery-email ${email}: suppressed — ${res.reason || 'unknown'}`);
    } catch (e: any) {
      failures.push(`reserve-recovery-email ${email}: send failed — ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // ── Recovery SMS (opt-in only, later, distinct angle) ──
  for (const ref of smsEligible) {
    const rancher = await rancherForReferral(ref);
    if (!rancher) continue;
    const consumerLinks = ref.Buyer as unknown;
    const consumerId = Array.isArray(consumerLinks) ? String(consumerLinks[0] || '') : '';
    if (!consumerId) continue;
    const state = ref['Buyer State'];
    smsPlanned++;

    // SMS send-window gate — defer (no stamp) outside the local SMS window.
    if (!isSmsWindow(state, nowMs)) {
      smsDeferred++;
      continue;
    }
    if (!live) continue;

    // Need the consumer record for TCPA opt-in + phone (sendSMSToConsumer gates).
    let consumer: any = null;
    try {
      consumer = await getRecordById(TABLES.CONSUMERS, consumerId);
    } catch {
      consumer = null;
    }
    if (!consumer) continue;

    const cut = cutLabelToCut(ref['Order Type']);
    const link = recoveryLink(consumerId, rancher, cut);
    const firstName = String(ref['Buyer Name'] || consumer['Full Name'] || '').trim().split(/[ @]/)[0] || 'there';
    const body = renderRecoverySms({
      firstName,
      cut: cut || 'beef',
      rancher: rancher.name,
      link,
      socialProof: proofForRancher(proof, rancher.id),
    });

    // CLAIM BEFORE SEND — stamp the SMS-recovery field first (idempotent).
    try {
      await updateRecord(TABLES.REFERRALS, ref.id, {
        [RESERVE_RECOVERY_SMS_FIELD]: now.toISOString(),
      });
    } catch (e: any) {
      failures.push(`reserve-recovery-sms ${ref.id}: stamp failed, skipped — ${e?.message?.slice(0, 80) || 'unknown'}`);
      continue;
    }
    if (!smsOn) continue;
    try {
      const ok = await sendSMSToConsumer({
        consumer,
        body,
        reason: 'demand-router reserve-recovery',
      });
      if (ok) smsSent++;
    } catch (e: any) {
      failures.push(`reserve-recovery-sms ${ref.id}: send failed — ${e?.message?.slice(0, 80) || 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { emailPlanned, emailSent, emailDeferred, smsPlanned, smsSent, smsDeferred };
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

  // 1. Capacity + 2. buyers + Upgrade B social proof (parallel reads).
  const [cap, buyers, proof] = await Promise.all([
    readCapacity(),
    readBuyers(),
    readSocialProof(nowMs),
  ]);

  // 3. PURE PLAN — selection + tiering + capacity gating + wave decisions +
  // suppression + sunset. EMAIL-LED: smsWaves empty so the planner does NOT fire
  // a simultaneous Msg2 SMS — SMS is a separate recovery touch (Upgrade C).
  const plan = buildCampaignPlan(buyers, {
    now: nowMs,
    capacity: { west: cap.west, eastCentral: cap.eastCentral },
    dailyCap: Number(process.env.CAMPAIGN_DAILY_CAP || 25),
    conversionBuffer: Number(process.env.CAMPAIGN_CONVERSION_BUFFER || 3),
    smsWaves: new Set(), // email-led; SMS handled by runSmsRecovery
  });

  const failures: string[] = [];
  let emailsSent = 0;
  let emailsDeferred = 0;
  let waitlisted = 0;
  let sunsetted = 0;

  if (live) {
    // ── EXECUTE: backfill email sends (window-gated, claim-before-send). ──
    for (const send of plan.sends) {
      try {
        const result = await executeSend(send, now, proofForRancher(proof, send.rancher.id), failures);
        if (result.emailOk) emailsSent++;
        if (result.deferred) emailsDeferred++;
        // Gentle pace between sends (deliverability) — the email lib also rate-
        // limits internally, this just spreads the loop.
        if (!result.deferred) await new Promise((resolve) => setTimeout(resolve, 250));
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
  } else {
    // DRY-RUN: count how many of the planned email sends WOULD defer on the
    // send-window (so the report is honest about timing), but stamp/send nothing.
    for (const send of plan.sends) {
      if (!isEmailWindow(send.state, nowMs)) emailsDeferred++;
    }
  }

  // 4. Upgrade C — SMS recovery touch (runs in dry-run as a plan count too).
  const smsRec = await runSmsRecovery(buyers, now, live, smsOn, proof, failures);

  // 5. Upgrade A — abandoned-reserve recovery (email then later SMS).
  const recovery = await runReserveRecovery(now, live, smsOn, proof, failures);

  // 6. Telegram report (always — dry-run reports the plan; live reports results).
  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      buildReport(plan, {
        live,
        smsOn,
        capDetail: cap.detail,
        failures,
        degraded: cap.degraded,
        emailsDeferred,
        proof,
        smsRec,
        recovery,
      }),
    );
  } catch {
    /* non-fatal */
  }

  const suppressedTotal = Object.values(plan.suppressed).reduce((a, b) => a + b, 0);
  const recordsTouched = live
    ? emailsSent + waitlisted + sunsetted + smsRec.sent + recovery.emailSent + recovery.smsSent
    : 0;
  const status: CronResult['status'] = failures.length > 0 ? 'partial' : 'success';
  const planned = plan.sends.length;
  const recoSummary =
    `reserve-recovery email=${recovery.emailSent}/${recovery.emailPlanned} sms=${recovery.smsSent}/${recovery.smsPlanned}` +
    ` · sms-recovery=${smsRec.sent}/${smsRec.planned}`;
  const notes = live
    ? `LIVE email=${emailsSent}/${planned} (deferred=${emailsDeferred}) ${recoSummary} waitlist=${waitlisted} sunset=${sunsetted} suppressed=${suppressedTotal} failures=${failures.length} (slots W=${cap.west} E/C=${cap.eastCentral})`
    : `DRY-RUN would email=${planned} (defer=${emailsDeferred}) ${recoSummary} · waitlist=${plan.waitlist.length} sunset=${plan.sunset.length} suppressed=${suppressedTotal} (slots W=${cap.west} E/C=${cap.eastCentral}) — set CAMPAIGN_LIVE=true to arm`;

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
