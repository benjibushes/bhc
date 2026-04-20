import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { sendRancherLeadNudge } from '@/lib/email';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode, maintenanceResponse } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export const maxDuration = 60;

// Runs every Monday at 9am MT — finds ranchers stalled at each onboarding stage
// and sends Telegram alerts with action buttons
//
// Airtable Onboarding Status options:
// "Call Scheduled", "Call Complete", "Docs Sent", "Agreement Signed",
// "Verification Pending", "Verification Complete", "Live"
async function handler(request: Request) {
  try {
    if (isMaintenanceMode()) return maintenanceResponse('rancher-followup');

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
      return NextResponse.json({ success: true, stalled: 0 });
    }

    // Send one Telegram alert per stalled rancher
    const thresholdMap: Record<string, number> = { ...STALL_THRESHOLDS, 'New Applicant': 2 };

    for (const { rancher, stage, daysStuck, isNewApplicant } of stalled) {
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
      const staleOnes = staleReferrals.filter(r => {
        const ts = r['Intro Sent At'] || r['Created'] || r.createdTime;
        return ts && new Date(ts).getTime() < fiveDaysAgo;
      });

      // Group by rancher
      const byRancher: Record<string, { rancherId: string; leads: Array<{ buyerName: string; status: string; daysSince: number }> }> = {};
      for (const r of staleOnes) {
        const rancherIds: string[] = r['Rancher'] || r['Suggested Rancher'] || [];
        if (!Array.isArray(rancherIds) || rancherIds.length === 0) continue;
        const rancherId = rancherIds[0];
        const ts = r['Intro Sent At'] || r['Created'] || r.createdTime;
        const daysSince = Math.floor((now.getTime() - new Date(ts).getTime()) / DAY_MS);
        if (!byRancher[rancherId]) byRancher[rancherId] = { rancherId, leads: [] };
        byRancher[rancherId].leads.push({
          buyerName: r['Buyer Name'] || 'Unknown Buyer',
          status: r['Status'] || 'Unknown',
          daysSince,
        });
      }

      // Send nudge to each rancher with stale leads
      for (const [rancherId, { leads }] of Object.entries(byRancher)) {
        try {
          const rancher = ranchers.find((r: any) => r.id === rancherId) as any;
          if (!rancher) continue;
          const rancherEmail = rancher['Email'] || '';
          if (!rancherEmail) continue;
          const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
          const dashboardUrl = `${SITE_URL}/rancher`;
          await sendRancherLeadNudge({ rancherName, email: rancherEmail, leads, dashboardUrl });
          nudgesSent++;
        } catch (e: any) {
          console.error('Lead nudge error:', e.message);
        }
      }
    } catch (e: any) {
      console.error('Stale lead nudge error:', e.message);
    }

    return NextResponse.json({ success: true, stalled: stalled.length, nudgesSent });
  } catch (error: any) {
    console.error('Rancher follow-up error:', error);
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `⚠️ Rancher follow-up cron failed: ${error.message}`
    ).catch(() => {});
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handler(request);
}

export async function POST(request: Request) {
  return handler(request);
}
