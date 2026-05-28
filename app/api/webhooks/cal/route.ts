import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { getAllRecords, updateRecord, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { logAuditEntry, buildAirtableUpdateReverse } from '@/lib/auditLog';

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
//   BOOKING_RESCHEDULED  → if rancher was in cancelled / empty / New state, flip
//                          back to "Call Scheduled" (cancel-then-rebook flow);
//                          otherwise just Telegram-alert. Always alerts.
//   BOOKING_CANCELLED    → revert Onboarding Status from "Call Scheduled" back
//                          to "" so wizard's alreadyBooked gate flips false and
//                          rancher-followup cron can nudge them to rebook.
//                          Telegram alert always.
//   MEETING_ENDED        → flip Onboarding Status to "Call Complete" so wizard
//                          unblocks the signing step. NO-SHOW guard: if Cal
//                          payload signals attendee no-show, suppress the
//                          auto-advance and Telegram-alert admin to follow up.
//
// Setup endpoint (Cal.com → BHC) is created via API at:
//   /Users/benji.bushes/BHC/untitled folder/bhc/scripts/_setup-cal-webhook.mjs
// Webhook ID: 470e07e5-09b9-497d-86c5-110bbd4e1520
//
// Audit: every Airtable mutation here writes an audit entry via logAuditEntry()
// so admin can replay reverse-actions from /admin/audit if a webhook fires
// in error (e.g. spoofed BOOKING_CANCELLED before Cal hardens signing).

function verifyCalSignature(rawBody: string, headers: Headers): boolean {
  const secret = process.env.CAL_WEBHOOK_SECRET;
  if (!secret) {
    // Audit finding 2026-05-20 #4: fail-CLOSED in prod, warn-only in non-prod.
    if (process.env.NODE_ENV === 'production') {
      console.error('[cal webhook] CAL_WEBHOOK_SECRET unset in prod — refusing all requests');
      return false;
    }
    console.warn('[cal webhook] CAL_WEBHOOK_SECRET not set (non-prod) — skipping signature verification');
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
          // pre-call stages (empty / New / already Call Scheduled). Note we
          // do NOT include later stages: a rancher who is e.g. Verification
          // Pending and books a follow-up call shouldn't get knocked back.
          if (!currentStatus || currentStatus === 'Call Scheduled' || currentStatus === 'New') {
            const reverse = buildAirtableUpdateReverse(TABLES.RANCHERS, rancher.id, {
              'Onboarding Status': rancher['Onboarding Status'],
              'Call Scheduled': rancher['Call Scheduled'],
            });
            await updateRecord(TABLES.RANCHERS, rancher.id, {
              'Onboarding Status': 'Call Scheduled',
              'Call Scheduled': true,
            });
            await logAuditEntry({
              actor: 'cron',
              tool: 'cal-webhook-booking-created',
              targetType: 'Rancher',
              targetId: rancher.id,
              args: { attendeeEmail, startTime, previousStatus: currentStatus },
              result: { status: 'Call Scheduled', callScheduled: true },
              reverseAction: reverse,
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
          ? `Status: ${rancher['Onboarding Status'] || 'New'}\n\n<i>After the call, tap below to unlock their wizard signing step. MEETING_ENDED webhook also flips this automatically if Cal.com fires it.</i>`
          : '⚠️ Not found in rancher database — they may have booked with a different email than they self-submitted with.'),
        rancher
          ? {
              inline_keyboard: [
                [{ text: '✅ Mark Call Complete', callback_data: `rcallcompl_${rancher.id}` }],
              ],
            }
          : undefined
      );
    }

    else if (triggerEvent === 'MEETING_ENDED') {
      // Auto-flip Onboarding Status='Call Complete' so the rancher's setup
      // wizard unblocks the signing step without operator intervention.
      // Cal.com fires MEETING_ENDED when the booking's end time passes.
      //
      // No-show guard: Cal v2 can signal no-show via either
      //   - bookingPayload.attendees[i].noShow (boolean per-attendee)
      //   - bookingPayload.noShowHost (boolean — host didn't show)
      //   - bookingPayload.noShow (rare, top-level)
      // If ANY attendee was a no-show, we DO NOT advance the wizard — a no-show
      // call hasn't actually qualified the rancher, so the signing step should
      // stay gated. Alert admin to follow up manually.
      const attendeeNoShow =
        Array.isArray(attendees) &&
        attendees.some((a: any) => a && (a.noShow === true || a.no_show === true));
      const hostNoShow =
        bookingPayload.noShowHost === true || bookingPayload.no_show_host === true;
      const topLevelNoShow = bookingPayload.noShow === true || bookingPayload.no_show === true;
      const isNoShow = attendeeNoShow || hostNoShow || topLevelNoShow;

      if (isNoShow) {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🚨 <b>RANCHER NO-SHOW</b>\n\n` +
          `🤠 ${rancherName}\n` +
          `📧 ${attendeeEmail}\n` +
          `📅 ${dateDisplay} MT\n\n` +
          `<i>Cal flagged ${hostNoShow ? 'host' : 'attendee'} as no-show — wizard NOT auto-advanced. ` +
          (rancher
            ? `Reach out to rebook, or use /bhc-ops to advance manually if call did happen.</i>`
            : `Rancher not in DB either — likely junk booking.</i>`)
        );
        return NextResponse.json({ success: true, event: triggerEvent, rancher: rancherName, noShow: true });
      }

      if (rancher) {
        try {
          const currentStatus = (rancher['Onboarding Status'] || '').toString();
          // Only advance from Call Scheduled — don't overwrite Agreement
          // Signed / Verification Complete / Live if rancher somehow got
          // ahead via dashboard.
          if (currentStatus === 'Call Scheduled') {
            const reverse = buildAirtableUpdateReverse(TABLES.RANCHERS, rancher.id, {
              'Onboarding Status': rancher['Onboarding Status'],
              'Call Completed At': rancher['Call Completed At'],
            });
            await updateRecord(TABLES.RANCHERS, rancher.id, {
              'Onboarding Status': 'Call Complete',
              'Call Completed At': new Date().toISOString().slice(0, 10),
            });
            await logAuditEntry({
              actor: 'cron',
              tool: 'cal-webhook-meeting-ended',
              targetType: 'Rancher',
              targetId: rancher.id,
              args: { attendeeEmail, previousStatus: currentStatus },
              result: { status: 'Call Complete' },
              reverseAction: reverse,
            });
            await sendTelegramMessage(
              TELEGRAM_ADMIN_CHAT_ID,
              `✅ <b>CALL COMPLETE (auto)</b>\n\n🤠 ${rancherName}\n📧 ${attendeeEmail}\n\n<i>Onboarding Status auto-advanced to Call Complete via Cal.com MEETING_ENDED. Wizard signing step is now unblocked for them.</i>`
            );
          }
        } catch (e) {
          console.error('[cal webhook] MEETING_ENDED update failed:', e);
        }
      } else {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `⚠️ <b>UNMATCHED MEETING_ENDED</b>\n\n📧 ${attendeeEmail}\n📅 ${dateDisplay} MT\n\n<i>Call ended but attendee email doesn't match any Rancher row.</i>`
        );
      }
    }

    else if (triggerEvent === 'BOOKING_CANCELLED') {
      // Revert Onboarding Status if rancher was sitting in Call Scheduled —
      // without this, the wizard's alreadyBooked gate (status==='Call Scheduled')
      // would falsely report they're booked AND the rancher-followup cron's
      // threshold for "Call Scheduled" stage would never fire a rebook nudge
      // (it keys off createdTime, not call time, and ranchers are usually
      // >2 days post-signup by this point so the rancher LOOKS overdue
      // forever). Clearing to '' puts them back in the New Applicant nudge
      // loop. Don't downgrade later-stage ranchers (Docs Sent, etc.) — a
      // late-stage rancher cancelling a follow-up call shouldn't reset.
      if (rancher) {
        try {
          const currentStatus = (rancher['Onboarding Status'] || '').toString();
          if (currentStatus === 'Call Scheduled') {
            const reverse = buildAirtableUpdateReverse(TABLES.RANCHERS, rancher.id, {
              'Onboarding Status': rancher['Onboarding Status'],
              'Call Scheduled': rancher['Call Scheduled'],
            });
            await updateRecord(TABLES.RANCHERS, rancher.id, {
              'Onboarding Status': '',
              'Call Scheduled': false,
            });
            await logAuditEntry({
              actor: 'cron',
              tool: 'cal-webhook-booking-cancelled',
              targetType: 'Rancher',
              targetId: rancher.id,
              args: { attendeeEmail, previousStatus: currentStatus },
              result: { status: '', callScheduled: false },
              reverseAction: reverse,
            });
          }
        } catch (e) {
          console.error('[cal webhook] BOOKING_CANCELLED update failed:', e);
        }
      }
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `❌ <b>CALL CANCELLED</b>\n\n` +
        `🤠 ${rancherName}\n` +
        `📧 ${attendeeEmail}\n` +
        `Originally: ${dateDisplay} MT` +
        (rancher
          ? `\n\n<i>Onboarding Status reset — rancher-followup cron will nudge them to rebook.</i>`
          : `\n\n<i>⚠️ Rancher not in DB — no status change applied.</i>`)
      );
    }

    else if (triggerEvent === 'BOOKING_RESCHEDULED') {
      // If a rancher cancelled (status reset to '') and then rebooks via the
      // SAME Cal link, Cal can fire BOOKING_RESCHEDULED rather than
      // BOOKING_CREATED. Flip status back to 'Call Scheduled' for empty/New
      // ranchers so the wizard and stalled-call cron see them correctly.
      if (rancher) {
        try {
          const currentStatus = (rancher['Onboarding Status'] || '').toString();
          if (!currentStatus || currentStatus === 'New') {
            const reverse = buildAirtableUpdateReverse(TABLES.RANCHERS, rancher.id, {
              'Onboarding Status': rancher['Onboarding Status'],
              'Call Scheduled': rancher['Call Scheduled'],
            });
            await updateRecord(TABLES.RANCHERS, rancher.id, {
              'Onboarding Status': 'Call Scheduled',
              'Call Scheduled': true,
            });
            await logAuditEntry({
              actor: 'cron',
              tool: 'cal-webhook-booking-rescheduled',
              targetType: 'Rancher',
              targetId: rancher.id,
              args: { attendeeEmail, startTime, previousStatus: currentStatus },
              result: { status: 'Call Scheduled', callScheduled: true },
              reverseAction: reverse,
            });
          }
        } catch (e) {
          console.error('[cal webhook] BOOKING_RESCHEDULED update failed:', e);
        }
      }
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🔄 <b>CALL RESCHEDULED</b>\n\n` +
        `🤠 ${rancherName}\n` +
        `📅 New time: ${dateDisplay} MT\n` +
        `📧 ${attendeeEmail}` +
        (rancher ? '' : `\n\n<i>⚠️ Rancher not in DB.</i>`)
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
