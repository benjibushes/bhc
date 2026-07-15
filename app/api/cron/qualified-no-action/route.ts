// app/api/cron/qualified-no-action/route.ts
//
// ABANDON-CART NUDGE — gentle re-engagement for matched buyers who
// didn't act (no deposit) within a small window after their intro
// went out.
//
// Pattern from Crowd Cow + ButcherBox + Shopify cart abandonment data:
// 60-90 min post-decision is the sweet spot for first nudge. Earlier =
// pushy; later = forgotten. Email + optional SMS (gated on opt-in).
//
// Schedule: hourly. Window: Intro Sent At 30min-4h ago.
// Dedup: stamp Consumer Notes "[no-action-nudge YYYY-MM-DD]" so each buyer
// fires at most once.
//
// SELECTOR HISTORY (why this cron queries REFERRALS, not Consumers):
// the previous Consumers formula excluded {Buyer Stage}='MATCHED', while the
// per-buyer loop required a Referral with Status='Intro Sent'. Matching sets
// BOTH together (matching/suggest flips the Referral to 'Intro Sent' and the
// Consumer to Buyer Stage='MATCHED' in the same pass) — so the formula
// pre-excluded everyone the loop could nudge. Hourly cron, selected ~0 rows,
// nudged nobody, forever. (A prior comment here mis-blamed the "tight 4h
// window" — the window was fine; the selector was structurally dead.)
// The selection now lives in lib/noActionNudge.ts, pure + red-first tested:
// Referrals with Status='Intro Sent' + blank Deposit Paid At minted 30min-4h
// ago, joined to the Consumer for the suppression trio + dedup + opt-ins.

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import {
  NUDGE_WINDOW_MIN_MS,
  NUDGE_WINDOW_MAX_MS,
  buildNudgeReferralFormula,
  isNudgeEligibleReferral,
  isNudgeEligibleConsumer,
} from '@/lib/noActionNudge';
import { isMaintenanceMode } from '@/lib/maintenance';
import { isRancherOnConnect } from '@/lib/rancherEligibility';
import { sendEmail } from '@/lib/email';
import { sendSMSToConsumer } from '@/lib/twilio';
import { isSmsWindow } from '@/lib/sendWindow';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { generateMemberLoginToken } from '@/lib/secrets';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

interface CronResult {
  status: 'success' | 'partial' | 'error' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
}

function esc(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// CTA: both destinations require the bhc-member-auth cookie, so the link is
// the magic-link verify hop (`/api/auth/member/verify?token=…&next=<path>`) —
// verify sets the cookie then 302s onward. Same pattern as the intro email
// (matching/suggest) and bulkRoute. A bare /checkout link would 401.
//
// WHICH nextPath depends on the rancher: only Connect-active tier_v2 ranchers
// (isRancherOnConnect) can take money at /checkout/<refId>/deposit — the
// deposit route hard-409s for everyone else (app/api/checkout/deposit
// Connect-status gate). Legacy / not-yet-active ranchers get the /member
// dashboard CTA instead of a "Reserve your slot" promise the page can't keep.
function buildNudgeMagicLink(buyerId: string, buyerEmail: string, nextPath: string): string {
  const magicToken = generateMemberLoginToken(buyerId, buyerEmail);
  return `${SITE_URL}/api/auth/member/verify?token=${magicToken}&next=${encodeURIComponent(nextPath)}`;
}

function buildEmailHtml(args: {
  firstName: string;
  rancherName: string;
  state: string;
  ctaUrl: string;
  ctaLabel: string;
}): { subject: string; html: string } {
  const first = args.firstName || 'there';
  const subject = `${first}, your match with ${args.rancherName} is still open`;
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px;">
<div style="max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A;">
  <h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 16px;">Hey ${esc(first)} —</h1>
  <p>Saw you got matched with <strong>${esc(args.rancherName)}</strong> in ${esc(args.state)} earlier today but haven't locked your slot yet. No pressure — wanted to make sure the link didn't get lost.</p>
  <p><strong>What happens if you don't act:</strong> the slot sits open for someone else in your state. ${esc(args.rancherName)}&rsquo;s processing dates fill on a first-come basis.</p>
  <p><strong>If you have questions before deciding:</strong> hit reply. I read every email and answer same-day.</p>
  <div style="text-align:center;margin:24px 0;">
    <a href="${args.ctaUrl}" style="display:inline-block;padding:14px 32px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;">${esc(args.ctaLabel)} →</a>
  </div>
  <p style="font-size:13px;color:#6B4F3F;">— Benjamin, BuyHalfCow</p>
</div>
</body></html>`;
  return { subject, html };
}

async function realHandler(_request: Request): Promise<CronResult> {
  // Maintenance gate — no sends while the platform is paused.
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  // Kill-switch gate
  if (process.env.MATCHING_ENABLED === 'false') {
    return { status: 'partial', recordsTouched: 0, notes: 'skipped — MATCHING_ENABLED=false' };
  }

  // Window: intro sent within last 4h but at least 30min ago. Anchoring on
  // Intro Sent At (not Qualified At) means buyers matched hours after
  // qualifying — batch-approve, demand-router — still get their nudge.
  const now = Date.now();
  const cutoffStart = new Date(now - NUDGE_WINDOW_MAX_MS).toISOString();
  const cutoffEnd = new Date(now - NUDGE_WINDOW_MIN_MS).toISOString();

  // Referrals-first selection (see header + lib/noActionNudge.ts). The
  // formula bounds Airtable I/O to the window; the pure predicates re-check
  // every row in the loop (formula = optimization, predicate = truth).
  let candidateRefs: any[] = [];
  try {
    candidateRefs = (await getAllRecords(
      TABLES.REFERRALS,
      buildNudgeReferralFormula(cutoffStart, cutoffEnd),
    )) as any[];
  } catch (e: any) {
    return { status: 'error', recordsTouched: 0, notes: `airtable query failed: ${e?.message}` };
  }

  if (candidateRefs.length === 0) {
    return { status: 'success', recordsTouched: 0, notes: 'no intro-sent-no-deposit referrals in window' };
  }

  let nudgedEmail = 0;
  let nudgedSms = 0;
  const failures: string[] = [];
  // A buyer with multiple in-window referrals gets at most ONE nudge per run
  // (the Notes stamp already guarantees once-ever; this guards within-run).
  const seenBuyers = new Set<string>();

  for (const ref of candidateRefs) {
    // Re-check the formula's promise in JS — the inline formula burned this
    // cron once already (see header).
    if (!isNudgeEligibleReferral(ref, now)) continue;

    const buyerId: string = (Array.isArray(ref['Buyer']) && ref['Buyer'][0]) || '';
    if (!buyerId || seenBuyers.has(buyerId)) continue;
    seenBuyers.add(buyerId);

    // Join to the Consumer for the suppression trio + dedup stamp + opt-ins.
    let c: any;
    try {
      c = await getRecordById(TABLES.CONSUMERS, buyerId);
    } catch {
      // Lookup failed — skip rather than nudge blind (suppression unknown).
      continue;
    }
    if (!isNudgeEligibleConsumer(c)) continue;

    const email = String(c['Email'] || '').trim();
    const firstName = String(c['Full Name'] || '').split(' ')[0] || 'there';
    const state = String(c['State'] || '');
    const rancherName = ref['Suggested Rancher Name'] || ref['Rancher Name'] || 'your rancher';

    // Deposit CTA only when the deposit rail can actually take this buyer's
    // money (rancher is tier_v2 + Connect active). Rancher lookup failure
    // falls back to the /member CTA — safe for every rancher type.
    let depositCapable = false;
    const rancherId: string =
      (Array.isArray(ref['Rancher']) && ref['Rancher'][0]) ||
      (Array.isArray(ref['Suggested Rancher']) && ref['Suggested Rancher'][0]) ||
      '';
    if (rancherId) {
      try {
        const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
        depositCapable = isRancherOnConnect(rancher);
      } catch {}
    }

    // Claim BEFORE sending: stamp the dedup note first so a stamp failure skips
    // + retries next run rather than re-nudging. This cron runs hourly with a
    // ~3.5h eligibility window (multiple ticks), and the template isn't
    // frequency-capped against itself — so a stamp-after-send (the old order)
    // would double-nudge by email AND SMS on any stamp hiccup.
    try {
      const existing = String(c['Notes'] || '');
      await updateRecord(TABLES.CONSUMERS, buyerId, {
        'Notes': `[no-action-nudge ${new Date().toISOString().slice(0, 10)}] ${existing}`.slice(0, 2000),
      });
    } catch (e: any) {
      failures.push(`${email}: stamp ${e?.message || 'unknown'} (skipped send to avoid dup)`);
      continue;
    }

    // One-tap deep link for THIS referral (cookie-setting magic hop):
    // deposit page when the rail can take money, member dashboard otherwise.
    const ctaUrl = depositCapable
      ? buildNudgeMagicLink(buyerId, email, `/checkout/${ref.id}/deposit`)
      : buildNudgeMagicLink(buyerId, email, '/member');
    const ctaLabel = depositCapable ? 'Reserve your slot' : 'View your match';

    // Email
    try {
      const { subject, html } = buildEmailHtml({ firstName, rancherName, state, ctaUrl, ctaLabel });
      const r: any = await sendEmail({
        to: email,
        subject,
        html,
        templateName: 'sendQualifiedNoActionNudge',
        _replyContext: { type: 'usr', recordId: buyerId },
      });
      if (!r?.suppressed) nudgedEmail++;
    } catch (e: any) {
      failures.push(`${email}: email ${e?.message || 'unknown'}`);
    }

    // SMS (opt-in only — sendSMSToConsumer re-checks SMS Opt-In + Unsub
    // internally, but we gate here too so we don't waste the call).
    //
    // TCPA QUIET-HOURS GATE (8pm-8am local): only text inside the buyer's local
    // SMS window (isSmsWindow — lib/sendWindow.ts, same gate the demand-router
    // uses). The nudge EMAIL already fired above and the dedup note is stamped,
    // so outside the window we simply forgo the bonus SMS channel rather than
    // risk a quiet-hours text.
    if (c['SMS Opt-In'] && isSmsWindow(state, Date.now())) {
      try {
        const ok = await sendSMSToConsumer({
          consumer: c,
          body: depositCapable
            ? `Hey ${firstName} — your match with ${rancherName} is still open. Lock your slot: ${ctaUrl} — Ben @ BuyHalfCow (reply STOP to opt out)`
            : `Hey ${firstName} — your match with ${rancherName} is still open. See your match: ${ctaUrl} — Ben @ BuyHalfCow (reply STOP to opt out)`,
          reason: 'qualified-no-action-nudge',
        });
        if (ok) nudgedSms++;
      } catch (e: any) {
        failures.push(`${email}: sms ${e?.message || 'unknown'}`);
      }
    }
  }

  // Operator visibility — only fire Telegram if we actually nudged
  // anyone, so the daily noise stays low.
  if (nudgedEmail > 0 || nudgedSms > 0) {
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `📨 <b>QUALIFIED-NO-ACTION NUDGE</b>\n\nEmail: ${nudgedEmail}\nSMS: ${nudgedSms}\nFailures: ${failures.length}`,
      );
    } catch {}
  }

  const status: CronResult['status'] = failures.length > 0 ? 'partial' : 'success';
  return {
    status,
    recordsTouched: nudgedEmail + nudgedSms,
    notes: `refsInWindow=${candidateRefs.length} email=${nudgedEmail} sms=${nudgedSms} failures=${failures.length}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('qualified-no-action', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
