import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramMessage, sendTelegramUpdate, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { callClaude } from '@/lib/ai';
import { sendRepeatPurchaseEmail } from '@/lib/email';
import jwt from 'jsonwebtoken';

const DAY_MS = 24 * 60 * 60 * 1000;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const OLLAMA_URL = process.env.OLLAMA_BASE_URL || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_CONFIGURED = !!(OLLAMA_URL || ANTHROPIC_KEY);

// Runs daily at 11am MT (17:00 UTC)
// Finds referrals stalled for 5+ days, drafts AI re-engagement emails, sends to Telegram for approval
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

    if (!AI_CONFIGURED) {
      return NextResponse.json({ success: false, error: 'AI not configured (set OLLAMA_BASE_URL or ANTHROPIC_API_KEY)' });
    }

    const referrals = await getAllRecords(
      TABLES.REFERRALS,
      'OR({Status} = "Intro Sent", {Status} = "Rancher Contacted")'
    ) as any[];

    const stale = referrals.filter(r => {
      const lastActivity = r['Last Chased At'] || r['Intro Sent At'] || r['Approved At'];
      if (!lastActivity) return false;
      return (Date.now() - new Date(lastActivity).getTime()) >= 5 * DAY_MS;
    });

    if (stale.length === 0) {
      return NextResponse.json({ success: true, stale: 0, drafted: 0 });
    }

    let drafted = 0;
    let errors = 0;

    for (const referral of stale.slice(0, 8)) {
      try {
        const buyerName = referral['Buyer Name'] || 'the buyer';
        const buyerEmail = referral['Buyer Email'] || '';
        const rancherName = referral['Suggested Rancher Name'] || 'the rancher';
        const daysStale = Math.floor((Date.now() - new Date(referral['Last Chased At'] || referral['Intro Sent At'] || referral['Approved At']).getTime()) / DAY_MS);

        const draftPrompt = `Draft a friendly, concise re-engagement email for a beef buyer who was introduced to a rancher ${daysStale} days ago and we haven't heard back. 2-3 short paragraphs. Warm, not pushy. Do NOT include a subject line — just the body paragraphs. Sign as Benjamin from BuyHalfCow.

Buyer: ${buyerName}, ${referral['Buyer State'] || ''}
Rancher introduced: ${rancherName}
Order interest: ${referral['Order Type'] || 'bulk beef'}, Budget: ${referral['Budget Range'] || 'not specified'}`;

        const draft = await callClaude({
          model: 'claude-sonnet-4-6',
          system: `You are Ben's AI business assistant for BuyHalfCow, a private beef brokerage. Write warm, direct emails that feel personal.`,
          user: draftPrompt,
          maxTokens: 500,
        });

        // Store draft in referral record
        await updateRecord(TABLES.REFERRALS, referral.id, {
          'AI Chase Draft': draft,
        });

        const preview = draft.length > 200 ? draft.substring(0, 200) + '...' : draft;

        await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID,
          `🎯 <b>REFERRAL CHASE-UP</b>

👤 ${buyerName} → 🤠 ${rancherName}
📧 ${buyerEmail || 'no email'}
Status: ${referral['Status']} | ${daysStale} days stale

<b>AI Draft:</b>
<i>"${preview}"</i>`,
          {
            inline_keyboard: [[
              { text: '📧 Send to Consumer', callback_data: `chasend_${referral.id}` },
              { text: '⏭️ Skip', callback_data: `chaskip_${referral.id}` },
            ]],
          }
        );

        drafted++;
      } catch (err: any) {
        console.error(`Chase-up error for referral ${referral.id}:`, err.message);
        errors++;
      }
    }

    if (stale.length > 8) {
      await sendTelegramUpdate(`<i>...and ${stale.length - 8} more stalled referrals not shown. Run /chasup for more.</i>`);
    }

    if (drafted > 0) {
      await sendTelegramUpdate(`🎯 <b>Referral Chase-Up Complete</b>\n\n${stale.length} stalled referrals found\n${drafted} drafts sent for review${errors > 0 ? `\n⚠️ ${errors} errors` : ''}`);
    }

    // ── Repeat purchase emails — 30 days post-close ────────────────────────
    let repeatSent = 0;
    try {
      const closedReferrals = await getAllRecords(
        TABLES.REFERRALS,
        '{Status} = "Closed Won"'
      ) as any[];

      const thirtyDaysAgo = Date.now() - 30 * DAY_MS;
      const repeatCandidates = closedReferrals.filter(r => {
        if (r['Repeat Outreach Sent']) return false;
        const closedAt = r['Closed At'];
        if (!closedAt) return false;
        return new Date(closedAt).getTime() < thirtyDaysAgo;
      });

      for (const referral of repeatCandidates) {
        try {
          const buyerEmail = referral['Buyer Email'] || '';
          const buyerName = referral['Buyer Name'] || '';
          if (!buyerEmail) continue;

          const firstName = buyerName.split(' ')[0] || 'there';
          const rancherName = referral['Suggested Rancher Name'] || 'your rancher';

          // Build a magic login link for the consumer
          const consumerIds: string[] = referral['Buyer'] || [];
          const consumerId = consumerIds[0] || '';
          const token = consumerId
            ? jwt.sign(
                { type: 'member-login', consumerId, email: buyerEmail.trim().toLowerCase() },
                JWT_SECRET,
                { expiresIn: '7d' }
              )
            : '';
          const loginUrl = token ? `${SITE_URL}/member/verify?token=${token}` : `${SITE_URL}/member`;

          await sendRepeatPurchaseEmail({ firstName, email: buyerEmail, rancherName, loginUrl });
          await updateRecord(TABLES.REFERRALS, referral.id, { 'Repeat Outreach Sent': true });
          repeatSent++;
        } catch (e: any) {
          console.error('Repeat purchase email error:', e.message);
        }
      }
    } catch (e: any) {
      console.error('Repeat purchase query error:', e.message);
    }

    if (repeatSent > 0) {
      await sendTelegramUpdate(`🔄 <b>Repeat Purchase Emails</b>: ${repeatSent} sent to past buyers`);
    }

    return NextResponse.json({ success: true, stale: stale.length, drafted, errors, repeatSent });
  } catch (error: any) {
    console.error('Referral chase-up cron error:', error);
    await sendTelegramUpdate(`⚠️ Referral chase-up cron failed: ${error.message}`).catch(() => {});
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
