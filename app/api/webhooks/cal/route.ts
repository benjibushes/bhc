import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export const maxDuration = 60;

// Cal.com webhook handler
// Set this URL in Cal.com: Settings → Webhooks → https://buyhalfcow.com/api/webhooks/cal
// Subscribe to: BOOKING_CREATED, BOOKING_CANCELLED, BOOKING_RESCHEDULED

export async function POST(request: Request) {
  try {
    const payload = await request.json();

    const triggerEvent = payload.triggerEvent || '';
    const bookingPayload = payload.payload || {};
    const attendees = bookingPayload.attendees || [];
    const organizer = bookingPayload.organizer || {};
    const startTime = bookingPayload.startTime || '';
    const endTime = bookingPayload.endTime || '';
    const title = bookingPayload.title || 'Onboarding Call';

    // Find the attendee email (not the organizer/Ben)
    const attendeeEmail = attendees.length > 0
      ? attendees[0].email?.trim().toLowerCase()
      : '';

    if (!attendeeEmail) {
      return NextResponse.json({ success: true, note: 'No attendee email found' });
    }

    // Try to match attendee to a rancher in Airtable
    let ranchers: any[] = [];
    try {
      ranchers = await getAllRecords(
        TABLES.RANCHERS,
        `{Email} = "${escapeAirtableValue(attendeeEmail)}"`
      );
    } catch (e) {
      console.error('Cal webhook: Error querying ranchers:', e);
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
      // Update rancher onboarding status
      if (rancher) {
        try {
          const currentStatus = rancher['Onboarding Status'] || '';
          // Only update if they haven't progressed past Call Scheduled
          if (!currentStatus || currentStatus === 'Call Scheduled' || currentStatus === 'New') {
            await updateRecord(TABLES.RANCHERS, rancher.id, {
              'Onboarding Status': 'Call Scheduled',
              'Call Scheduled': true,
            });
          }
        } catch (e) {
          console.error('Cal webhook: Error updating rancher:', e);
        }
      }

      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `📞 <b>CALL BOOKED</b>\n\n` +
        `🤠 ${rancherName}\n` +
        `📅 ${dateDisplay} MT\n` +
        `📧 ${attendeeEmail}\n` +
        (rancher ? `Status: ${rancher['Onboarding Status'] || 'New'}` : '⚠️ Not found in rancher database')
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
    console.error('Cal.com webhook error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Cal.com may send a GET to verify the endpoint
export async function GET() {
  return NextResponse.json({ status: 'ok', handler: 'cal.com webhook' });
}
