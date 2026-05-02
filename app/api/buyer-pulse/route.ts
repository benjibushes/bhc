// Buyer pulse response handler — receives one-tap buyer answers from the
// buyer-pulse cron emails. Records the answer + Telegrams Ben so he can
// rescue ghosting buyers in real time.

import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { logAuditEntry, buildAirtableUpdateReverse } from '@/lib/auditLog';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token');
    if (!token) return NextResponse.redirect(`${SITE_URL}/?error=missing-token`);

    let payload: any;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return NextResponse.redirect(`${SITE_URL}/?error=expired-token`);
    }
    if (payload.type !== 'buyer-pulse' || !payload.referralId || !payload.answer) {
      return NextResponse.redirect(`${SITE_URL}/?error=bad-token`);
    }

    const { referralId, buyerId, answer } = payload as {
      referralId: string;
      buyerId: string;
      answer: 'connected' | 'ghosted' | 'stalled';
    };

    const ref = await getRecordById(TABLES.REFERRALS, referralId) as any;
    const buyer = buyerId ? await getRecordById(TABLES.CONSUMERS, buyerId) as any : null;
    const previousResponse = ref?.['Buyer Pulse Response'];
    const reverse = buildAirtableUpdateReverse(TABLES.REFERRALS, referralId, {
      'Buyer Pulse Response': previousResponse || null,
      'Buyer Pulse Response At': ref?.['Buyer Pulse Response At'] || null,
    });

    // Record the answer
    try {
      await updateRecord(TABLES.REFERRALS, referralId, {
        'Buyer Pulse Response': answer,
        'Buyer Pulse Response At': new Date().toISOString(),
      });
    } catch (e: any) {
      console.warn('[buyer-pulse] field write failed (Buyer Pulse Response field may not exist):', e?.message);
    }

    // Audit log
    try {
      await logAuditEntry({
        actor: 'manual',
        tool: 'buyer-pulse-response',
        targetType: 'Referral',
        targetId: referralId,
        args: { answer },
        result: { previousResponse, newResponse: answer },
        reverseAction: reverse,
      });
    } catch {}

    // Telegram alert — different urgency by answer
    const buyerName = buyer?.['Full Name'] || '?';
    const buyerEmail = buyer?.['Email'] || '?';
    const buyerState = buyer?.['State'] || '?';
    const buyerPhone = buyer?.['Phone'] || '';
    const rancherName = ref?.['Suggested Rancher Name'] || '?';

    let alertEmoji = '📨';
    let alertHeader = 'Buyer pulse';
    let actionLine = '';
    if (answer === 'ghosted') {
      alertEmoji = '🚨';
      alertHeader = 'GHOSTED — buyer says rancher never reached out';
      actionLine = `\n<b>ACTION:</b> Reach out to ${rancherName} or re-route this buyer. Buyer is hot — they tapped "No, never heard back."`;
    } else if (answer === 'stalled') {
      alertEmoji = '⚠️';
      alertHeader = 'Stalled — buyer engaged but conversation paused';
      actionLine = `\n<b>ACTION:</b> Light touch. Buyer says they're talking but stuck. Could be price, timing, or just dragging.`;
    } else if (answer === 'connected') {
      alertEmoji = '✅';
      alertHeader = 'Connected — buyer is actively in conversation';
      actionLine = `\n<i>No action needed. Conversation is live.</i>`;
    }

    try {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `${alertEmoji} <b>${alertHeader}</b>\n\n` +
        `👤 ${buyerName} (${buyerState})\n` +
        `📧 ${buyerEmail}` +
        (buyerPhone ? ` · 📞 ${buyerPhone}` : '') + `\n` +
        `🤠 Routed to: ${rancherName}\n` +
        `🆔 <code>${referralId}</code>` +
        actionLine
      );
    } catch (e: any) {
      console.error('[buyer-pulse] Telegram alert failed:', e?.message);
    }

    // Render a simple thank-you page (no JWT auto-login on this — keeps the
    // surface minimal for the first version; we can expand to /member redirect
    // with cookie auto-login later).
    const responseLine =
      answer === 'connected' ? "Glad to hear it! I'll let your rancher keep running with it."
      : answer === 'ghosted' ? "I'm on it. I'll personally make sure you get a rancher who actually shows up — expect to hear from me today."
      : "Got it. I'll check in with the rancher and see if there's anything blocking — usually it's a quick fix.";

    const html = `<!DOCTYPE html><html><head><title>Thanks — BuyHalfCow</title>
<style>body{font-family:-apple-system,sans-serif;background:#F4F1EC;margin:0;padding:60px 20px;color:#0E0E0E}.c{max-width:520px;margin:0 auto;background:white;padding:48px 36px;border:1px solid #A7A29A;text-align:center}h1{font-family:Georgia,serif;font-size:28px;margin:0 0 24px}p{color:#2A2A2A;line-height:1.7;font-size:16px}</style>
</head><body><div class="c">
<h1>Thanks for the heads up.</h1>
<p>${responseLine}</p>
<p style="margin-top:32px;font-size:14px;color:#6B6B6B;">— Benjamin</p>
</div></body></html>`;

    return new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (error: any) {
    console.error('[buyer-pulse] error:', error);
    return NextResponse.redirect(`${SITE_URL}/?error=server`);
  }
}
