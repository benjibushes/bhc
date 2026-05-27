import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { sendRancherLeadNudge } from '@/lib/email';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';

export const maxDuration = 60;

// Per-run ceiling — protects against unbounded outreach under cohort growth.
// Matches existing caps on buyer-pulse + email-sequences.
const MAX_PER_RUN = 25;

// Runs daily 15 UTC — exits early unless today is Monday. Vercel Hobby tier
// silently dropped the original `0 15 * * 1` day-of-week schedule (0 runs in
// 14 days as of 2026-05-19 audit). Daily wrapper + Monday guard ensures the
// cron actually fires on Mondays + Cron Runs has a row every day proving we
// DID check.
async function realHandler(_request: Request): Promise<{ status: 'success' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  // 0=Sunday, 1=Monday. Use UTC so we don't drift across DST.
  const today = new Date();
  if (today.getUTCDay() !== 1) {
    return { status: 'success', recordsTouched: 0, notes: `skipped — not Monday (UTC day=${today.getUTCDay()})` };
  }

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

      // Handle new applicants: ranchers with NO onboarding status set (just applied)
      if (!status) {
        const created = new Date(rancher.createdTime || 0);
        const daysOld = Math.floor((now.getTime() - created.getTime()) / DAY_MS);
        if (daysOld >= 2) {
          stalled.push({ rancher, stage: 'New Applicant', daysStuck: daysOld, isNewApplicant: true });
        }
        continue;
      }

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

    if (stalled.length === 0) {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        '✅ <b>Rancher Follow-Up Check</b>\n\nAll ranchers are progressing on schedule. Nothing stalled.'
      );
      return { status: 'success', recordsTouched: 0, notes: 'no stalled ranchers' };
    }

    // Send one Telegram alert per stalled rancher
    const thresholdMap: Record<string, number> = { ...STALL_THRESHOLDS, 'New Applicant': 2 };

    let processed = 0;
    for (const { rancher, stage, daysStuck, isNewApplicant } of stalled) {
      if (processed >= MAX_PER_RUN) {
        console.log(`[rancher-followup] hit MAX_PER_RUN=${MAX_PER_RUN}, stopping stalled-rancher alerts`);
        break;
      }
      const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Unknown Rancher';
      const state = rancher['State'] || '?';
      const email = rancher['Email'] || 'no email';
      const phone = rancher['Phone'] || '';

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
    }

    // Summary message
    const summaryLines = stalled.map(
      ({ rancher, stage, daysStuck }) =>
        `• ${rancher['Operator Name'] || rancher['Ranch Name']} — ${stage} (${daysStuck}d)`
    );

    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `📊 <b>Follow-Up Summary</b>: ${stalled.length} rancher${stalled.length !== 1 ? 's' : ''} need attention\n\n${summaryLines.join('\n')}`
    );

    // ── Stale lead nudge emails to active ranchers ─────────────────────────
    let nudgesSent = 0;
    try {
      const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
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
      const { updateRecord } = await import('@/lib/airtable');
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

  return {
    status: 'success',
    recordsTouched: stalled.length + nudgesSent,
    notes: `stalled=${stalled.length} nudges=${nudgesSent}`,
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
