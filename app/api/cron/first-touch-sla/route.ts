// app/api/cron/first-touch-sla/route.ts
//
// 48H FIRST-TOUCH SLA (close-the-loop 2026-07-15). Forensics: only 38% of
// 703 intros ever got a real rancher touch, and "couldn't reach buyer" is
// the #1 rancher-reported loss reason downstream — the un-called intro is
// the platform's biggest silent leak. Daily pass over Intro Sent referrals:
//
//   48h untouched → ONE SMS nudge to the rancher (first_touch_sla_rancher,
//     ENABLE_SMS-gated + rancher-local quiet hours via isSmsWindow), stamped
//     on 'First Touch Nudged At' (fldCovvSweQKCp3Wh) so it can never repeat.
//     Rancher out of the SMS window or without a textable phone falls back
//     to the existing rancher email-nudge pattern (nudgerancher's copy) —
//     the stamp still guarantees exactly one nudge per referral either way.
//     CROSS-THROTTLED against referral-chasup L2a (which emails this same
//     Intro Sent ≥2d population at 17:05 UTC on a 4d 'Rancher Reminded At'
//     window): the selector holds the nudge while chasup's stamp is <48h
//     fresh, and the nudge stamps 'Rancher Reminded At' alongside its own
//     field so chasup skips for 4d after — one automated ping per referral
//     per window, never two crons an hour apart, on either channel.
//
//   96h still untouched (nudged or not) → one Telegram card to Ben per
//     referral, throttled on 'Stalled Alert Sent At' — the SAME field +
//     3-day cooldown referral-chasup's stalled cards use, so two crons can
//     never double-card one referral. Card reuses the existing one-tap
//     actions (nudgerancher / reassign / closelost / details).
//
// "Untouched" is lib/untouchedIntros needsFirstCall — imported via
// lib/firstTouchSla's pure selectors (unit-tested), never forked. Stamp
// BEFORE send (close-detector pattern): a lost send is better than a
// re-nudge loop forever.
//
// Operator-tier ranchers are skipped: BHC's team runs those closes (#396),
// so "you owe the buyer a first call" would contradict the Operator promise.
//
// No env gate by design — this is a rancher-facing ops nudge in the same
// always-on class as referral-chasup / deposit-accept-sla; the SMS leg is
// already dark until ENABLE_SMS via fireRancherSMSEvent (email leg carries
// the nudge meanwhile). Buyer privacy in logs + cards: first name + last
// initial only.

import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import {
  selectFirstTouchNudges,
  selectFirstTouchEscalations,
  privacyName,
  buyerFirstLabel,
  type FirstTouchRef,
} from '@/lib/firstTouchSla';
import { fireRancherSMSEvent } from '@/lib/smsEvents';
import { smsEnabled } from '@/lib/smsFlag';
import { isSmsWindow } from '@/lib/sendWindow';
import { normalizePhoneE164, formatPhonePretty, telHref } from '@/lib/phoneHygiene';
import { tierFor } from '@/lib/tiers';
import { isBrokerRancher } from '@/lib/brokerRail';

export const maxDuration = 120;

const DAY_MS = 24 * 60 * 60 * 1000;
// Per-run caps: the SLA is a daily drumbeat, not a backfill cannon.
const MAX_NUDGES_PER_RUN = 25;
const MAX_ESCALATIONS_PER_RUN = 10;

interface CronResult {
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown?: Record<string, number>;
}

const str = (v: any): string => {
  if (v == null) return '';
  if (typeof v === 'object' && 'name' in v) return String(v.name);
  return String(v);
};

// Buyer/rancher-supplied strings go into email HTML — escape them
// (email-hygiene 2026-08-02; matches lib/email.ts esc()). Subjects stay raw.
function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function realHandler(_request: Request): Promise<CronResult> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const now = Date.now();

  // Scale-safe read: server-side filter to Intro Sent rows whose intro is
  // already past the 48h SLA (the 96h escalation set is a subset), projected
  // to the fields this cron reads.
  const rows = (await getAllRecords(
    TABLES.REFERRALS,
    `AND({Status} = "Intro Sent", {Intro Sent At}, IS_BEFORE({Intro Sent At}, DATEADD(NOW(), -48, 'hours')))`,
    {
      fields: [
        'Status', 'Intro Sent At', 'Last Rancher Activity At',
        'First Touch Nudged At', 'Stalled Alert Sent At', 'Rancher Reminded At',
        'Buyer Name', 'Buyer State', 'Buyer Phone', 'Order Type',
        'Rancher', 'Suggested Rancher', 'Suggested Rancher Name',
      ],
    },
  )) as any[];

  const refs: Array<FirstTouchRef & { raw: any }> = rows.map((r) => ({
    id: r.id,
    status: str(r['Status']),
    introSentAt: r['Intro Sent At'] || undefined,
    lastRancherActivityAt: r['Last Rancher Activity At'] || undefined,
    firstTouchNudgedAt: r['First Touch Nudged At'] || undefined,
    stalledAlertSentAt: r['Stalled Alert Sent At'] || undefined,
    rancherRemindedAt: r['Rancher Reminded At'] || undefined,
    raw: r,
  }));

  // Rancher resolution rides the cached table read (same as close-detector).
  const ranchers = (await getAllRecords(TABLES.RANCHERS)) as any[];
  const ranchersById = new Map(ranchers.map((r: any) => [r.id, r]));
  const rancherFor = (raw: any) => {
    const links = raw['Rancher'] || raw['Suggested Rancher'] || [];
    const id = Array.isArray(links) ? links[0] : null;
    return id ? ranchersById.get(id) : null;
  };

  const skips: Record<string, number> = {};
  const skip = (reason: string) => { skips[reason] = (skips[reason] || 0) + 1; };

  // ── 48h: one nudge per referral, SMS first, email fallback ────────────────
  // The cap counts ACTUAL nudge attempts, not selector rows: exclusions below
  // (no rancher / inactive / operator / no channel) never stamp, so they
  // re-qualify daily — if they consumed cap slots, 25 stale rows on
  // deactivated ranchers would sit oldest-first at the head of the queue and
  // starve every real nudge until stale-hold expiry flips them Dormant.
  let smsSent = 0;
  let emailSent = 0;
  let sendFailed = 0;
  let attempted = 0;
  for (const ref of selectFirstTouchNudges(refs, now, Number.MAX_SAFE_INTEGER)) {
    if (attempted >= MAX_NUDGES_PER_RUN) break;
    try {
      const rancher = rancherFor(ref.raw);
      if (!rancher) { skip('no-rancher-linked'); continue; }
      // BROKER RAIL — explicit, ahead of the Active Status line. A represented
      // ranch was only ever skipped here BY ACCIDENT: its `Active Status` is
      // left blank at signup, so the next line caught it. That is one admin
      // checkbox away from SMSing / emailing a ranch that "is still waiting on
      // your first call" about a buyer it was never introduced to and cannot
      // be — on this rail nobody calls, the buyer pays a deposit. The nudge
      // also offers to "reroute this buyer", which no represented ranch has any
      // standing to answer. Chased by the operator escalation instead.
      if (isBrokerRancher(rancher)) { skip('broker-rail'); continue; }
      if (str(rancher['Active Status']) !== 'Active') { skip('rancher-inactive'); continue; }
      if (tierFor(rancher) === 'operator') { skip('operator-tier'); continue; }

      const rancherPhone = str(rancher['Phone']).trim();
      const rancherEmail = str(rancher['Email']).trim();
      const buyerFirst = buyerFirstLabel(ref.raw['Buyer Name']);
      const buyerState = str(ref.raw['Buyer State']);
      const cut = str(ref.raw['Order Type']);
      const buyerPhoneE164 = normalizePhoneE164(ref.raw['Buyer Phone']);

      const canSms =
        smsEnabled() && !!normalizePhoneE164(rancherPhone) && isSmsWindow(rancher['State'], now);
      if (!canSms && !rancherEmail) { skip('no-reachable-channel'); continue; }

      // From here on this row consumes a cap slot (it costs Airtable writes +
      // a send), whether or not the send ultimately succeeds.
      attempted++;

      // Stamp BEFORE sending (close-detector pattern): if the stamp fails we
      // abort — a repeat-nudge loop is worse than one lost nudge. 'Rancher
      // Reminded At' rides along so referral-chasup L2a's 4d throttle absorbs
      // this nudge instead of emailing the same rancher an hour later (the
      // selector holds our side when chasup stamped first — see
      // CROSS_NUDGE_SUPPRESS_MS in lib/firstTouchSla).
      try {
        await updateRecord(TABLES.REFERRALS, ref.id, {
          'First Touch Nudged At': new Date().toISOString(),
          'Rancher Reminded At': new Date().toISOString(),
        });
      } catch (stampErr: any) {
        skip('stamp-failed');
        console.error('[first-touch-sla] stamp failed for', ref.id, stampErr?.message);
        continue;
      }

      if (canSms) {
        const ok = await fireRancherSMSEvent({
          type: 'first_touch_sla_rancher',
          phone: rancherPhone,
          vars: {
            buyerFirstName: buyerFirst,
            state: buyerState,
            cut,
            buyerPhone: buyerPhoneE164 || undefined,
          },
        });
        if (ok) smsSent++;
        else sendFailed++;
      } else {
        // Email fallback — the existing rancher nudge pattern (Telegram
        // nudgerancher handler's copy, lowercased to brand voice, one CTA).
        const { sendEmail } = await import('@/lib/email');
        const days = ref.introSentAt
          ? Math.max(2, Math.floor((now - new Date(ref.introSentAt).getTime()) / DAY_MS))
          : 2;
        const callLink = buyerPhoneE164
          ? `<p style="margin:16px 0 4px 0;text-align:center;"><a href="${telHref(buyerPhoneE164)}" style="display:inline-block;padding:12px 24px;background:#0E0E0E;color:#FFFFFF!important;text-decoration:none;font-weight:600;font-size:14px;">call ${esc(buyerFirst)} — ${formatPhonePretty(buyerPhoneE164)}</a></p>`
          : '';
        await sendEmail({
          to: rancherEmail,
          subject: `quick nudge — ${buyerFirst} is still waiting on your first call`,
          html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
            <p>Hi ${esc(str(rancher['Operator Name']) || str(rancher['Ranch Name']) || 'there')},</p>
            <p>${esc(buyerFirst)}${buyerState ? ` in ${esc(buyerState)}` : ''} matched with you ${days} days ago${cut ? ` looking for a ${esc(cut.toLowerCase())}` : ''} — and hasn't heard from you yet.</p>
            <p>A two-minute first call is what keeps these deals alive. Even "got your info, here's my next processing date" works.</p>
            ${callLink}
            ${buyerPhoneE164 ? `<p style="font-size:13px;color:#6B4F3F;text-align:center;">or text them: ${formatPhonePretty(buyerPhoneE164)}</p>` : ''}
            <p>If you're slammed and need me to reroute this buyer, just reply and say so.</p>
            <p>— Ben</p>
            <p style="font-size:12px;color:#A7A29A;margin-top:30px;">BuyHalfCow</p>
          </div>`,
        });
        emailSent++;
      }
    } catch (e: any) {
      sendFailed++;
      console.error('[first-touch-sla] nudge failed for', ref.id, e?.message || e);
    }
  }

  // ── 96h: escalation cards to Ben (shared chasup throttle field) ───────────
  let escalated = 0;
  let escalationFailed = 0;
  for (const ref of selectFirstTouchEscalations(refs, now, MAX_ESCALATIONS_PER_RUN)) {
    try {
      const rancher = rancherFor(ref.raw);
      // BROKER RAIL — this half had NO rancher gate at all. The card it posts
      // carries a "📞 Nudge Rancher" button whose callback emails the ranch the
      // same wrong-rail chase the 48h half now skips. Broker deals are chased
      // by the operator deposit escalation (lib/depositSla), not by nudging a
      // ranch that is waiting on a deposit rather than making a call.
      if (rancher && isBrokerRancher(rancher)) { skip('broker-rail'); continue; }
      const rancherName =
        (rancher && (str(rancher['Operator Name']) || str(rancher['Ranch Name']))) ||
        str(ref.raw['Suggested Rancher Name']) || 'unknown rancher';
      const buyerLabel = privacyName(ref.raw['Buyer Name']);
      const buyerState = str(ref.raw['Buyer State']) || '?';
      const cut = str(ref.raw['Order Type']) || '?';
      const days = ref.introSentAt
        ? Math.floor((now - new Date(ref.introSentAt).getTime()) / DAY_MS)
        : 4;

      // Stamp the shared throttle BEFORE posting (close-detector pattern) so
      // a stamp failure aborts the card instead of minting a daily repeat.
      try {
        await updateRecord(TABLES.REFERRALS, ref.id, {
          'Stalled Alert Sent At': new Date().toISOString(),
        });
      } catch (stampErr: any) {
        skip('escalation-stamp-failed');
        console.error('[first-touch-sla] escalation stamp failed for', ref.id, stampErr?.message);
        continue;
      }

      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `⏰ <b>NO FIRST TOUCH — ${days}d</b>\n\n` +
          `🤠 <b>${rancherName}</b> hasn't touched 👤 ${buyerLabel} (${buyerState}) in ${days} days — reassign?\n` +
          `📦 ${cut} · intro ${days}d ago\n` +
          `🆔 <code>${ref.id}</code>`,
        {
          inline_keyboard: [
            [
              { text: '📞 Nudge Rancher', callback_data: `nudgerancher_${ref.id}` },
              { text: '🔄 Reassign', callback_data: `reassign_${ref.id}` },
            ],
            [
              { text: '🔒 Close Lost', callback_data: `closelost_${ref.id}` },
              { text: '👁 Details', callback_data: `details_${ref.id}` },
            ],
          ],
        },
      );
      escalated++;
      // Pace Telegram sends (per-bot rate limit) — close-detector's 600ms.
      await new Promise((r) => setTimeout(r, 600));
    } catch (e: any) {
      escalationFailed++;
      console.error('[first-touch-sla] escalation failed for', ref.id, e?.message || e);
    }
  }

  // One summary line so Ben sees the sweep happened (only when it acted).
  const nudged = smsSent + emailSent;
  if (nudged > 0 || escalated > 0) {
    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `⏱ <b>first-touch SLA sweep</b> — nudged <b>${nudged}</b> rancher${nudged === 1 ? '' : 's'} ` +
          `(sms ${smsSent} / email ${emailSent}) · escalated <b>${escalated}</b>` +
          (sendFailed + escalationFailed > 0 ? ` · ⚠️ ${sendFailed + escalationFailed} failed` : ''),
      );
    } catch {}
  }

  const failed = sendFailed + escalationFailed;
  return {
    status: failed > 0 ? 'partial' : 'success',
    recordsTouched: nudged + escalated,
    notes:
      `nudged=${nudged} (sms=${smsSent} email=${emailSent}) escalated=${escalated} ` +
      `failed=${failed} scanned=${refs.length}`,
    skipReasonBreakdown: Object.keys(skips).length ? skips : undefined,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('first-touch-sla', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
