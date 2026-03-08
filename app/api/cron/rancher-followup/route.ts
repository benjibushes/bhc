import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

// Runs every Monday at 9am MT — finds ranchers stalled at each onboarding stage
// and sends Telegram alerts with action buttons
export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      const { searchParams } = new URL(request.url);
      const secret = searchParams.get('secret');
      if (secret !== process.env.CRON_SECRET || !process.env.CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const ranchers = await getAllRecords(TABLES.RANCHERS);
    const now = new Date();
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Stage thresholds in days — escalate if stuck this long
    const STALL_THRESHOLDS: Record<string, number> = {
      'Applied':         3,   // Should be called within 3 days
      'Call Scheduled':  2,   // Call overdue
      'Docs Sent':       7,   // Agreement not signed in 7 days
      'Agreement Signed': 5,  // Verification not started in 5 days
      'In Verification': 14,  // Verification taking too long
    };

    const stalled: Array<{
      rancher: any;
      stage: string;
      daysStuck: number;
      dateField: string;
    }> = [];

    for (const rancher of ranchers as any[]) {
      const status = rancher['Onboarding Status'] || '';
      const activeStatus = rancher['Active Status'] || '';

      // Skip live and inactive ranchers
      if (activeStatus === 'Inactive' || status === 'Live' || status === 'Rejected') continue;
      if (!status) continue;

      const threshold = STALL_THRESHOLDS[status];
      if (!threshold) continue;

      // Figure out which date field to check per stage
      let dateField = '';
      let dateValue = '';
      if (status === 'Applied') {
        dateField = 'Created';
        dateValue = rancher['Created'] || rancher.createdTime || '';
      } else if (status === 'Call Scheduled') {
        dateField = 'Call Scheduled At';
        dateValue = rancher['Call Scheduled At'] || '';
      } else if (status === 'Docs Sent') {
        dateField = 'Docs Sent At';
        dateValue = rancher['Docs Sent At'] || '';
      } else if (status === 'Agreement Signed') {
        dateField = 'Agreement Signed At';
        dateValue = rancher['Agreement Signed At'] || '';
      } else if (status === 'In Verification') {
        dateField = 'Verification Started At';
        dateValue = rancher['Verification Started At'] || rancher['Docs Sent At'] || '';
      }

      if (!dateValue) continue;

      const stageDate = new Date(dateValue);
      if (isNaN(stageDate.getTime())) continue;

      const daysStuck = Math.floor((now.getTime() - stageDate.getTime()) / DAY_MS);
      if (daysStuck >= threshold) {
        stalled.push({ rancher, stage: status, daysStuck, dateField });
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
    for (const { rancher, stage, daysStuck } of stalled) {
      const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Unknown Rancher';
      const state = rancher['State'] || '?';
      const email = rancher['Email'] || 'no email';
      const phone = rancher['Phone'] || '';

      const stageEmoji: Record<string, string> = {
        'Applied':          '📬',
        'Call Scheduled':   '📅',
        'Docs Sent':        '📄',
        'Agreement Signed': '✍️',
        'In Verification':  '🔬',
      };

      const urgency = daysStuck >= (STALL_THRESHOLDS[stage] || 7) * 2 ? '🚨' : '⚠️';

      const msg = `${urgency} <b>STALLED RANCHER</b>

🤠 <b>${name}</b> (${state})
${stageEmoji[stage] || '⏳'} Stage: <b>${stage}</b>
⏱ Stuck for <b>${daysStuck} day${daysStuck !== 1 ? 's' : ''}</b>
📧 ${email}${phone ? `\n📱 ${phone}` : ''}`;

      const keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> } = {
        inline_keyboard: [],
      };

      // Stage-specific action buttons
      if (stage === 'Applied' || stage === 'Call Scheduled') {
        const calLink = process.env.NEXT_PUBLIC_CALENDLY_LINK || '';
        if (calLink) {
          keyboard.inline_keyboard.push([{ text: '📅 Schedule Call', url: calLink }]);
        }
        keyboard.inline_keyboard.push([
          { text: '📦 Send Onboarding Docs', callback_data: `ronboard_${rancher.id}` },
        ]);
      } else if (stage === 'Docs Sent') {
        keyboard.inline_keyboard.push([
          { text: '📧 Re-send Onboarding', callback_data: `ronboard_${rancher.id}` },
        ]);
      } else if (stage === 'Agreement Signed' || stage === 'In Verification') {
        keyboard.inline_keyboard.push([
          { text: '📋 View Rancher', callback_data: `rdetails_${rancher.id}` },
        ]);
      }

      await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, msg, keyboard.inline_keyboard.length > 0 ? keyboard : undefined);
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

    return NextResponse.json({ success: true, stalled: stalled.length });
  } catch (error: any) {
    console.error('Rancher follow-up error:', error);
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `⚠️ Rancher follow-up cron failed: ${error.message}`
    ).catch(() => {});
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
