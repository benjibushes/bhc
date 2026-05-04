import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { getAllRecords, updateRecord, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export const maxDuration = 60;

// Cal.com webhook handler — Hybrid B onboarding wiring.
//
// Signature: Cal.com signs payloads with HMAC-SHA256 of raw body using the
// webhook secret. Header name varies between Cal.com versions:
//   - Newer: X-Cal-Signature-256 (hex digest)
//   - Older: X-Cal-Signature (also hex digest)
// We accept either header, reject if neither matches when CAL_WEBHOOK_SECRET
// is configured. If secret env is unset (e.g. local dev), skip verification
// but log a warning.
//
// Events handled:
//   BOOKING_CREATED      → flip Onboarding Status to "Call Scheduled" if rancher
//                          is in earlier stage. Telegram + ?email auto-match.
//   BOOKING_RESCHEDULED  → Telegram alert with new time. No status change.
//   BOOKING_CANCELLED    → Telegram alert. No status downgrade (rancher might
//                          rebook). Manual cleanup via bhc-ops if needed.
//
// Setup endpoint (Cal.com → BHC) is created via API at:
//   /Users/benji.bushes/BHC/untitled folder/bhc/scripts/_setup-cal-webhook.mjs
// Webhook ID: 470e07e5-09b9-497d-86c5-110bbd4e1520

function verifyCalSignature(rawBody: string, headers: Headers): boolean {
  const secret = process.env.CAL_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[cal webhook] CAL_WEBHOOK_SECRET not set — skipping signature verification');
    return true;
  }
  const sig =
    headers.get('x-cal-signature-256') ||
    headers.get('x-cal-signature') ||
    '';
  if (!sig) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // Constant-time compare to avoid timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(sig.replace(/^sha256=/, ''), 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  // Read raw body once for signature verification + JSON parsing
  const rawBody = await request.text();

  if (!verifyCalSignature(rawBody, request.headers)) {
    console.warn('[cal webhook] signature verification failed');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const triggerEvent = payload.triggerEvent || '';
    const bookingPayload = payload.payload || {};
    const attendees = bookingPayload.attendees || [];
    const startTime = bookingPayload.startTime || '';

    const attendeeEmail = attendees.length > 0
      ? (attendees[0].email || '').toString().trim().toLowerCase()
      : '';

    if (!attendeeEmail) {
      return NextResponse.json({ success: true, note: 'No attendee email found' });
    }

    let ranchers: any[] = [];
    try {
      ranchers = await getAllRecords(
        TABLES.RANCHERS,
        `LOWER({Email}) = "${escapeAirtableValue(attendeeEmail)}"`
      );
    } catch (e) {
      console.error('[cal webhook] Airtable lookup failed:', e);
    }

    const rancher = ranchers.length > 0 ? ranchers[0] : null;
    const rancherName = rancher
      ? (rancher['Operator Name'] || rancher['Ranch Name'] || attendeeEmail)
      : attendeeEmail;

    const dateDisplay = startTime
      ? new Date(startTime).toLocaleString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: 'America/Denver',
        })
      : 'TBD';

    if (triggerEvent === 'BOOKING_CREATED') {
      if (rancher) {
        try {
          const currentStatus = (rancher['Onboarding Status'] || '').toString();
          // Don't downgrade — only set Call Scheduled if rancher is in
          // pre-call stages (empty or already Call Scheduled).
          if (!currentStatus || currentStatus === 'Call Scheduled' || currentStatus === 'New') {
            await updateRecord(TABLES.RANCHERS, rancher.id, {
              'Onboarding Status': 'Call Scheduled',
              'Call Scheduled': true,
            });
          }
        } catch (e) {
          console.error('[cal webhook] update rancher failed:', e);
        }
      }

      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `📞 <b>CALL BOOKED</b>\n\n` +
        `🤠 ${rancherName}\n` +
        `📅 ${dateDisplay} MT\n` +
        `📧 ${attendeeEmail}\n` +
        (rancher
          ? `Status: ${rancher['Onboarding Status'] || 'New'}\n\n<i>After the call, tap Call Complete in Airtable or via /bhc-ops to unlock their wizard signing step.</i>`
          : '⚠️ Not found in rancher database — they may have booked with a different email than they self-submitted with.')
      );
    }

    else if (triggerEvent === 'BOOKING_CANCELLED') {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `❌ <b>CALL CANCELLED</b>\n\n` +
        `🤠 ${rancherName}\n` +
        `📧 ${attendeeEmail}\n` +
        `Originally: ${dateDisplay} MT`
      );
    }

    else if (triggerEvent === 'BOOKING_RESCHEDULED') {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🔄 <b>CALL RESCHEDULED</b>\n\n` +
        `🤠 ${rancherName}\n` +
        `📅 New time: ${dateDisplay} MT\n` +
        `📧 ${attendeeEmail}`
      );
    }

    return NextResponse.json({ success: true, event: triggerEvent, rancher: rancherName });
  } catch (error: any) {
    console.error('[cal webhook] handler error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ status: 'ok', handler: 'cal.com webhook · Hybrid B' });
}
