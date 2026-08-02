// Buyer pulse response handler — receives one-tap buyer answers from the
// buyer-pulse cron emails. Records the answer + Telegrams Ben so he can
// rescue ghosting buyers in real time.
//
// SCANNER GUARD (email-hygiene 2026-08-02): this used to mutate on GET —
// corporate mail scanners (SafeLinks / Mimecast) prefetch GET links straight
// out of the email, which recorded a false "ghosted" answer AND Telegram'd
// the operator a phantom rescue. Mirrors app/api/rancher/quick-action's
// pattern: the email URL is unchanged, GET now renders a one-button confirm
// page, and the form's POST performs the actual write. The buyer still taps
// exactly once on a real button.

import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { logAuditEntry, buildAirtableUpdateReverse } from '@/lib/auditLog';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

type PulseAnswer = 'connected' | 'ghosted' | 'stalled';

interface PulsePayload {
  referralId: string;
  buyerId: string;
  answer: PulseAnswer;
}

function verifyPulseToken(token: string | null): PulsePayload | null {
  if (!token) return null;
  let payload: any;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
  if (payload.type !== 'buyer-pulse' || !payload.referralId || !payload.answer) return null;
  if (!['connected', 'ghosted', 'stalled'].includes(payload.answer)) return null;
  return payload as PulsePayload;
}

function page(inner: string): NextResponse {
  const html = `<!DOCTYPE html><html><head><title>BuyHalfCow</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,sans-serif;background:#F4F1EC;margin:0;padding:60px 20px;color:#0E0E0E}.c{max-width:520px;margin:0 auto;background:white;padding:48px 36px;border:1px solid #A7A29A;text-align:center}h1{font-family:Georgia,serif;font-size:28px;margin:0 0 24px}p{color:#2A2A2A;line-height:1.7;font-size:16px}button{display:inline-block;padding:16px 32px;background:#0E0E0E;color:#F4F1EC;border:none;font-weight:700;font-size:15px;letter-spacing:1px;text-transform:uppercase;cursor:pointer}</style>
</head><body><div class="c">${inner}</div></body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// GET — token check + a single confirm button. No writes, no Telegram: a
// scanner prefetch renders this page and nothing else happens.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token');
    if (!token) return NextResponse.redirect(`${SITE_URL}/?error=missing-token`);
    const payload = verifyPulseToken(token);
    if (!payload) return NextResponse.redirect(`${SITE_URL}/?error=expired-token`);

    const copy: Record<PulseAnswer, { lead: string; button: string }> = {
      connected: {
        lead: "Glad to hear it's moving. One tap to confirm you and your rancher are talking:",
        button: "Yes — we're talking",
      },
      ghosted: {
        lead: "Sorry about that. One tap to confirm you never heard from your rancher, and I'll get on it personally:",
        button: 'Confirm — never heard back',
      },
      stalled: {
        lead: 'Got it. One tap to confirm the conversation started but stalled, and I’ll check what’s blocking:',
        button: 'Confirm — it stalled',
      },
    };
    const c = copy[payload.answer];
    return page(`
<h1>One tap to confirm.</h1>
<p>${c.lead}</p>
<form method="post" action="/api/buyer-pulse?token=${encodeURIComponent(token)}" style="margin-top:24px;">
  <button type="submit">${c.button}</button>
</form>
<p style="margin-top:28px;font-size:13px;color:#6B6B6B;">Tapped the wrong link in the email? Just close this page and use the right one.</p>`);
  } catch (error: any) {
    console.error('[buyer-pulse] GET error:', error);
    return NextResponse.redirect(`${SITE_URL}/?error=server`);
  }
}

// POST — the actual mutation (record answer + audit + operator Telegram).
export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const payload = verifyPulseToken(searchParams.get('token'));
    if (!payload) return NextResponse.redirect(`${SITE_URL}/?error=expired-token`, 303);

    const { referralId, buyerId, answer } = payload;

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

    return page(`
<h1>Thanks for the heads up.</h1>
<p>${responseLine}</p>
<p style="margin-top:32px;font-size:14px;color:#6B6B6B;">— Ben</p>`);
  } catch (error: any) {
    console.error('[buyer-pulse] error:', error);
    return NextResponse.redirect(`${SITE_URL}/?error=server`, 303);
  }
}
