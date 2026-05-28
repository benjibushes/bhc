import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { sendRancherLeadNudge, sendEmail } from '@/lib/email';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';

export const maxDuration = 60;

// Per-run ceiling — protects against unbounded outreach under cohort growth.
// Matches existing caps on buyer-pulse + email-sequences.
const MAX_PER_RUN = 25;

// Runs daily 15 UTC. Two paths inside this handler with different cadences:
//
//   1. Stale-lead nudge to ranchers about pending referrals — MONDAY ONLY
//      (weekly cadence; per-referral 7d throttle stamp on top).
//   2. New self-submit / blank-Onboarding-Status prospect nudge — DAILY
//      (per-rancher throttle via "Last Onboarding Nudge At" ≥ 2 days).
//   3. Stalled mid-funnel rancher Telegram digest to admin — MONDAY ONLY
//      (weekly admin summary; daily nudges to ranchers are handled by
//      /api/cron/onboarding-stuck so we don't double-nudge).
//
// Vercel Hobby tier silently dropped the original `0 15 * * 1` day-of-week
// schedule (0 runs in 14 days as of 2026-05-19 audit). Daily wrapper + in-code
// Monday guard on the Monday-only loops ensures the weekly work fires on
// Mondays + Cron Runs has a row every day proving we DID check, while the
// daily prospect-nudge loop runs every UTC day.
async function realHandler(_request: Request): Promise<{ status: 'success' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  // 0=Sunday, 1=Monday. Use UTC so we don't drift across DST.
  const today = new Date();
  const isMonday = today.getUTCDay() === 1;
  const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

  const ranchers = await getAllRecords(TABLES.RANCHERS);
    const now = new Date();
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Stage thresholds in days — escalate if stuck this long
    // Keys match actual Airtable Onboarding Status singleSelect values
    const STALL_THRESHOLDS: Record<string, number> = {
      'Call Scheduled':      2,   // Call overdue — check in immediately
      'Call Complete':       3,   // Docs not sent within 3 days of call
      'Docs Sent':           7,   // Agreement not signed in 7 days
      'Agreement Signed':    5,   // Verification not started in 5 days
      'Verification Pending': 14, // Verification taking too long
    };

    const stalled: Array<{
      rancher: any;
      stage: string;
      daysStuck: number;
      isNewApplicant: boolean;
    }> = [];

    for (const rancher of ranchers as any[]) {
      const status = rancher['Onboarding Status'] || '';
      const activeStatus = rancher['Active Status'] || '';

      // Skip live, paused, non-compliant ranchers
      if (['Paused', 'Non-Compliant'].includes(activeStatus)) continue;
      if (status === 'Live' || status === 'Verification Complete') continue;

      // Handle new applicants: ranchers with NO onboarding status set (just applied).
      // This path runs DAILY — self-submit prospects shouldn't wait up to 6 days
      // for first nudge.
      if (!status) {
        const created = new Date(rancher.createdTime || 0);
        const daysOld = Math.floor((now.getTime() - created.getTime()) / DAY_MS);
        if (daysOld >= 2) {
          stalled.push({ rancher, stage: 'New Applicant', daysStuck: daysOld, isNewApplicant: true });
        }
        continue;
      }

      // Below this line: stalled-mid-funnel checks. Telegram digest is weekly
      // (Monday only) to avoid spamming admin daily — daily rancher-facing
      // nudges for these stages are handled by /api/cron/onboarding-stuck.
      if (!isMonday) continue;

      const threshold = STALL_THRESHOLDS[status];
      if (!threshold) continue;

      // Figure out which date field to check per stage
      let dateValue = '';
      if (status === 'Call Scheduled') {
        dateValue = rancher['Created'] || rancher.createdTime || '';
      } else if (status === 'Call Complete') {
        dateValue = rancher['Call Completed At'] || rancher['Created'] || rancher.createdTime || '';
      } else if (status === 'Docs Sent') {
        dateValue = rancher['Docs Sent At'] || '';
      } else if (status === 'Agreement Signed') {
        dateValue = rancher['Agreement Signed At'] || '';
      } else if (status === 'Verification Pending') {
        dateValue = rancher['Docs Sent At'] || rancher['Agreement Signed At'] || '';
      }

      if (!dateValue) continue;

      const stageDate = new Date(dateValue);
      if (isNaN(stageDate.getTime())) continue;

      const daysStuck = Math.floor((now.getTime() - stageDate.getTime()) / DAY_MS);
      if (daysStuck >= threshold) {
        stalled.push({ rancher, stage: status, daysStuck, isNewApplicant: false });
      }
    }

    // Per-run send counter — used by both new-applicant nudges and the
    // Monday-only stale-lead loop.
    let processed = 0;
    let prospectNudgesSent = 0;

    if (stalled.length === 0) {
      // Only emit the "all clear" pulse on Monday — the daily-only new-applicant
      // path being empty is normal and not worth daily noise.
      if (isMonday) {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          '✅ <b>Rancher Follow-Up Check</b>\n\nAll ranchers are progressing on schedule. Nothing stalled.'
        );
      }
    } else {
      // Send one Telegram alert per stalled rancher.
      // For new-applicants we ALSO send a gentle reminder email to the prospect
      // (daily-eligible, gated by Last Onboarding Nudge At ≥ 2 days).
      const thresholdMap: Record<string, number> = { ...STALL_THRESHOLDS, 'New Applicant': 2 };

      for (const { rancher, stage, daysStuck, isNewApplicant } of stalled) {
      if (processed >= MAX_PER_RUN) {
        console.log(`[rancher-followup] hit MAX_PER_RUN=${MAX_PER_RUN}, stopping stalled-rancher alerts`);
        break;
      }
      const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Unknown Rancher';
      const state = rancher['State'] || '?';
      const email = rancher['Email'] || 'no email';
      const phone = rancher['Phone'] || '';

      // Per-rancher throttle for new-applicant path so daily cron doesn't spam.
      // Telegram-to-admin AND email-to-prospect both honor the same stamp.
      if (isNewApplicant) {
        const lastNudge = rancher['Last Onboarding Nudge At'];
        if (lastNudge) {
          const lastNudgeTime = new Date(lastNudge).getTime();
          if (isFinite(lastNudgeTime) && now.getTime() - lastNudgeTime < 2 * DAY_MS) {
            continue;
          }
        }
      }

      const stageEmoji: Record<string, string> = {
        'New Applicant':       '📬',
        'Call Scheduled':      '📅',
        'Call Complete':       '📞',
        'Docs Sent':           '📄',
        'Agreement Signed':    '✍️',
        'Verification Pending': '🔬',
      };

      const urgency = daysStuck >= (thresholdMap[stage] || 7) * 2 ? '🚨' : '⚠️';

      const msg = `${urgency} <b>STALLED RANCHER</b>

🤠 <b>${name}</b> (${state})
${stageEmoji[stage] || '⏳'} Stage: <b>${stage}</b>
⏱ Stuck for <b>${daysStuck} day${daysStuck !== 1 ? 's' : ''}</b>
📧 ${email}${phone ? `\n📱 ${phone}` : ''}`;

      const keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> } = {
        inline_keyboard: [],
      };

      if (isNewApplicant || stage === 'Call Scheduled') {
        const calLink = process.env.NEXT_PUBLIC_CALENDLY_LINK || '';
        if (calLink) {
          keyboard.inline_keyboard.push([{ text: '📅 Schedule Call', url: calLink }]);
        }
      }

      if (stage === 'Call Complete' || isNewApplicant) {
        keyboard.inline_keyboard.push([
          { text: '📦 Send Onboarding Docs', callback_data: `ronboard_${rancher.id}` },
        ]);
      } else if (stage === 'Docs Sent') {
        keyboard.inline_keyboard.push([
          { text: '📧 Re-send Onboarding', callback_data: `ronboard_${rancher.id}` },
        ]);
      }

      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        msg,
        keyboard.inline_keyboard.length > 0 ? keyboard : undefined
      );
      processed++;

      // Daily new-applicant gentle reminder email to the prospect themselves.
      // We stamp Last Onboarding Nudge At regardless of email outcome so we
      // don't retry every day on a permanently-bouncing address. Stamp BEFORE
      // the send so a throw doesn't leave the throttle unset.
      if (isNewApplicant) {
        const rancherEmail = (rancher['Email'] || '').toString().trim();
        const unsubscribed = !!rancher['Unsubscribed'];
        const stampNow = new Date().toISOString();
        try {
          await updateRecord(TABLES.RANCHERS, rancher.id, {
            'Last Onboarding Nudge At': stampNow,
          });
        } catch (stampErr: any) {
          console.warn('[rancher-followup] new-applicant throttle stamp failed:', rancher.id, stampErr?.message);
        }
        if (rancherEmail && !unsubscribed) {
          const first = (rancher['Operator Name'] || '').toString().split(' ')[0] || 'there';
          const ranchName = (rancher['Ranch Name'] || rancher['Operator Name'] || 'your ranch').toString();
          const calLink = process.env.NEXT_PUBLIC_CALENDLY_LINK || `${SITE_URL}/contact`;
          try {
            await sendEmail({
              to: rancherEmail,
              subject: `${first}, ${ranchName} is on the map — what's next?`,
              html: `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px;">
<div style="max-width:600px;margin:0 auto;background:#fff;padding:40px;border:1px solid #A7A29A;">
  <h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 18px;">Hey ${first},</h1>
  <p>Just a quick check-in &mdash; <strong>${ranchName}</strong> has been on the BuyHalfCow map for a couple days now. Yellow pin, visible to buyers, but not yet routed customers.</p>
  <p>The fastest way to flip from "visible" to "getting leads" is a 15-minute call. I'll show you what we do, ask how you sell today, and we figure out together if it's a fit.</p>
  <div style="text-align:center;margin:30px 0;">
    <a href="${calLink}" style="display:inline-block;padding:14px 30px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;font-size:13px;">Book the 15-min call</a>
  </div>
  <p style="font-size:13px;color:#6B4F3F;">If now isn't the right time, just reply and let me know. No pressure.</p>
  <p style="font-size:12px;color:#A7A29A;margin-top:30px;">&mdash; Ben<br>Founder, BuyHalfCow</p>
</div></body></html>`,
              _replyContext: { type: 'rnc', recordId: rancher.id },
            } as any);
            prospectNudgesSent++;
          } catch (emailErr: any) {
            console.error('[rancher-followup] new-applicant email failed:', rancher.id, emailErr?.message);
          }
        }
      }
      }

      // Monday-only summary digest. The daily new-applicant path leans on the
      // per-rancher Telegram alerts above; no need for a daily digest too.
      if (isMonday) {
        const summaryLines = stalled.map(
          ({ rancher, stage, daysStuck }) =>
            `• ${rancher['Operator Name'] || rancher['Ranch Name']} — ${stage} (${daysStuck}d)`
        );

        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `📊 <b>Follow-Up Summary</b>: ${stalled.length} rancher${stalled.length !== 1 ? 's' : ''} need attention\n\n${summaryLines.join('\n')}`
        );
      }
    }

    // ── Stale lead nudge emails to active ranchers ─────────────────────────
    // MONDAY ONLY — weekly cadence is the design (the loop also has a per-
    // referral 7-day throttle stamp on top of that, but the day-of-week is
    // the primary gate).
    let nudgesSent = 0;
    if (isMonday) {
    try {
      const staleReferrals = await getAllRecords(
        TABLES.REFERRALS,
        'OR({Status} = "Intro Sent", {Status} = "Rancher Contacted")'
      ) as any[];

      const fiveDaysAgo = now.getTime() - 5 * DAY_MS;
      const sevenDaysAgo = now.getTime() - 7 * DAY_MS;
      const staleOnes = staleReferrals.filter(r => {
        const ts = r['Intro Sent At'] || r['Created'] || r.createdTime;
        return ts && new Date(ts).getTime() < fiveDaysAgo;
      });

      // Group by rancher. Also tracks referral IDs so we can stamp throttle
      // per-referral after sending. Prior version had no throttle at all —
      // if Monday cron retried (or rancher's leads stayed stale week-over-week
      // without rancher engagement) ranchers received the same nudge weekly
      // until they replied. 7-day per-referral throttle prevents this.
      const byRancher: Record<string, {
        rancherId: string;
        leads: Array<{ buyerName: string; status: string; daysSince: number }>;
        refIds: string[];
      }> = {};
      for (const r of staleOnes) {
        const rancherIds: string[] = r['Rancher'] || r['Suggested Rancher'] || [];
        if (!Array.isArray(rancherIds) || rancherIds.length === 0) continue;

        // Per-referral throttle: skip if Rancher Reminded At within last 7d.
        // Mirrors awaiting-payment-nudge pattern using the same field name.
        const lastReminderAt = r['Rancher Reminded At']
          ? new Date(r['Rancher Reminded At']).getTime()
          : 0;
        if (lastReminderAt && lastReminderAt > sevenDaysAgo) continue;

        const rancherId = rancherIds[0];
        const ts = r['Intro Sent At'] || r['Created'] || r.createdTime;
        const daysSince = Math.floor((now.getTime() - new Date(ts).getTime()) / DAY_MS);
        if (!byRancher[rancherId]) byRancher[rancherId] = { rancherId, leads: [], refIds: [] };
        byRancher[rancherId].leads.push({
          buyerName: r['Buyer Name'] || 'Unknown Buyer',
          status: r['Status'] || 'Unknown',
          daysSince,
        });
        byRancher[rancherId].refIds.push(r.id);
      }

      // Send nudge to each rancher with stale leads. MISMATCH FIX: stamp
      // Rancher Reminded At on EACH referral in the bundle BEFORE the send.
      // If the email fires but the stamp write fails, the next cron run would
      // re-send a duplicate nudge. Stamping first means at worst we don't
      // nudge this week if the stamp lands but the email throws — the next
      // cron run will retry (since the stamp expires after 7d).
      for (const [rancherId, { leads, refIds }] of Object.entries(byRancher)) {
        if (processed >= MAX_PER_RUN) {
          console.log(`[rancher-followup] hit MAX_PER_RUN=${MAX_PER_RUN}, stopping lead-nudge emails`);
          break;
        }
        try {
          const rancher = ranchers.find((r: any) => r.id === rancherId) as any;
          if (!rancher) continue;
          const rancherEmail = rancher['Email'] || '';
          if (!rancherEmail) continue;
          const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
          const dashboardUrl = `${SITE_URL}/rancher`;

          // Stamp throttle on all referrals in the bundle first.
          const stampNow = new Date().toISOString();
          for (const refId of refIds) {
            try {
              await updateRecord(TABLES.REFERRALS, refId, {
                'Rancher Reminded At': stampNow,
              });
            } catch (stampErr: any) {
              console.warn('[rancher-followup] referral throttle stamp failed:', refId, stampErr?.message);
              // Continue — better to nudge with imperfect throttle than skip.
            }
          }

          await sendRancherLeadNudge({ rancherName, email: rancherEmail, leads, dashboardUrl });
          nudgesSent++;
          processed++;
        } catch (e: any) {
          console.error('Lead nudge error:', e.message);
        }
      }
    } catch (e: any) {
      console.error('Stale lead nudge error:', e.message);
    }
    }

  return {
    status: 'success',
    recordsTouched: stalled.length + nudgesSent + prospectNudgesSent,
    notes: `isMonday=${isMonday} stalled=${stalled.length} leadNudges=${nudgesSent} prospectNudges=${prospectNudgesSent}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      const { searchParams } = new URL(request.url);
      const secret = searchParams.get('secret');
      if (secret !== cronSecret) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('rancher-followup', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
