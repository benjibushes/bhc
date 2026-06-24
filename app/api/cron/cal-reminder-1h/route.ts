// app/api/cron/cal-reminder-1h/route.ts
//
// F18 — Send a reminder 1h before each booked Cal call.
//
// Why: industry no-show baseline is 18-25% on sales calls. A 1h reminder
// drops it to 5-10%. At Ben's call volume + close rate, that's real $.
//
// Pulls Conversations rows where Type=cal_booking AND Start Time in the
// next 55-70 min window. Dedup via Notes "[cal-reminder-1h]" stamp so
// repeats inside the same hour don't double-fire.
//
// Channels:
//   1. Email always (transactional)
//   2. SMS gated by F9 ENABLE_SMS + SMS Opt-In on Consumer
//
// Schedule: every 10 min via vercel.json.

import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { withCronRun } from '@/lib/cronRun';
import { CRON_SECRET } from '@/lib/secrets';

export const maxDuration = 120;

interface CronResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEmail(firstName: string, startTime: string, calLink: string) {
  const first = firstName || 'there';
  const when = startTime
    ? new Date(startTime).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      })
    : 'soon';
  const subject = `${first}, our call starts in 1 hour`;
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;margin:0;padding:20px;">
<div style="max-width:600px;margin:0 auto;background:white;padding:40px;border:1px solid #A7A29A;">
  <h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 16px;">Hey ${esc(first)} —</h1>
  <p>Quick reminder: our call starts at <strong>${esc(when)}</strong>. About an hour from now.</p>
  ${calLink ? `<p>Join link: <a href="${calLink}" style="color:#0E0E0E;">${esc(calLink)}</a></p>` : ''}
  <p>I'll walk you through the rancher match, processing timeline, and what locking your slot looks like. Bring questions — that's the whole point.</p>
  <p style="font-size:13px;color:#6B4F3F;">Need to reschedule? Reply to this email.<br>— Ben<br>BuyHalfCow<br><em>Connecting every household to a ranch they trust.</em></p>
</div>
</body></html>`;
  return { subject, html };
}

async function realHandler(_request: Request): Promise<CronResult> {
  const now = Date.now();
  const earlyMs = now + 55 * 60 * 1000;
  const lateMs = now + 70 * 60 * 1000;
  const earlyIso = new Date(earlyMs).toISOString();
  const lateIso = new Date(lateMs).toISOString();

  // R5 (2026-06-10): Cal bookings are stamped on Referrals.Sales Call
  // Booked At by the cal webhook (app/api/webhooks/cal/route.ts:253).
  // Conversations is for inbound email threads, NOT cal bookings, so
  // querying it for `Type='cal_booking'` always returned 0 rows and
  // errored on schema-unknown fields. Query Referrals instead.
  let bookings: any[] = [];
  try {
    // Window on the REAL call start time (Sales Call Start At), stamped by the
    // cal webhook on BOOKING_CREATED — NOT Sales Call Booked At (which is the
    // booking-creation timestamp and is always in the past, so a future window
    // never matched it → this cron sent nothing). Exclude calls already
    // completed so a finished call never gets a "starts in 1 hour" reminder.
    bookings = await getAllRecords(
      TABLES.REFERRALS,
      `AND(IS_AFTER({Sales Call Start At}, '${earlyIso}'), IS_BEFORE({Sales Call Start At}, '${lateIso}'), {Sales Call Completed At} = BLANK())`
    ) as any[];
  } catch (e: any) {
    console.warn('[cal-reminder-1h] bookings query failed:', e?.message);
    return { status: 'error', recordsTouched: 0, notes: e?.message };
  }

  if (bookings.length === 0) {
    return { status: 'success', recordsTouched: 0, notes: 'no bookings in window' };
  }

  let touched = 0;
  let skipped = 0;
  for (const b of bookings) {
    const notes = String(b['Notes'] || '');
    if (notes.includes('[cal-reminder-1h]')) {
      skipped++;
      continue;
    }
    // Defense-in-depth on top of the Completed At = BLANK() query filter:
    // never remind about a call that already happened.
    if (b['Sales Call Completed At']) {
      skipped++;
      continue;
    }
    const attendeeEmail = String(b['Buyer Email'] || '').toLowerCase().trim();
    if (!attendeeEmail) {
      skipped++;
      continue;
    }
    const attendeeName = String(b['Buyer Name'] || '').trim();
    const firstName = attendeeName.split(' ')[0] || 'there';
    // Real call start datetime, stamped by the cal webhook on BOOKING_CREATED.
    // The query above windows on it for [now+55m, now+70m], so the buyer's call
    // genuinely starts in ~1 hour and the email's displayed time is correct.
    const startTime = String(b['Sales Call Start At'] || '');
    const calLink = ''; // not stored on Referral; user can find via email

    // Stamp the dedup claim BEFORE sending. The send path (email + SMS) can't
    // be made idempotent, but the stamp can — so claim first. If the stamp
    // write fails, skip the send and let the next tick retry. Better a slightly
    // delayed reminder than a double email+SMS (this cron fires every 10 min
    // and the template is on the transactional whitelist, so the frequency cap
    // would NOT catch a duplicate).
    try {
      await updateRecord(TABLES.REFERRALS, b.id, {
        Notes: `[cal-reminder-1h ${new Date().toISOString().slice(0, 16)}] ${notes}`.slice(0, 2000),
      });
    } catch (e: any) {
      console.warn(`[cal-reminder-1h] stamp failed for ${b.id}, skipping send to avoid a duplicate:`, e?.message);
      skipped++;
      continue;
    }

    try {
      const { subject, html } = buildEmail(firstName, startTime, calLink);
      await sendEmail({
        to: attendeeEmail,
        subject,
        html,
        templateName: 'sendCalReminder1h',
      });
    } catch (e: any) {
      console.warn(`[cal-reminder-1h] email failed for ${attendeeEmail}:`, e?.message);
    }

    // F9 — SMS gated by feature flag + opt-in
    try {
      const consumerRows = await getAllRecords(
        TABLES.CONSUMERS,
        `LOWER({Email})="${attendeeEmail}"`
      ) as any[];
      const consumer = consumerRows[0];
      if (consumer) {
        const { fireSMSEvent } = await import('@/lib/smsEvents');
        await fireSMSEvent({
          type: 'cal_reminder',
          consumer,
          vars: { firstName },
        });
      }
    } catch (e: any) {
      console.warn(`[cal-reminder-1h] SMS lookup failed for ${attendeeEmail}:`, e?.message);
    }
    touched++;
  }

  if (touched > 0) {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `⏰ <b>Cal reminders sent (1h)</b>: ${touched} fired · ${skipped} skipped.`
    ).catch(() => {});
  }

  return {
    status: 'success',
    recordsTouched: touched,
    notes: `sent=${touched} skipped=${skipped}`,
  };
}

// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Also accept
// `?secret=` for manual/admin triggers. This was the ONLY mutating cron with
// no auth gate — it fires buyer email + SMS, so an unauthenticated caller
// could spam booked buyers. CRON_SECRET is requireEnv (fail-loud) in lib/secrets.
function isAuthedCron(request: Request): boolean {
  const authHeader = request.headers.get('authorization');
  if (authHeader === `Bearer ${CRON_SECRET}`) return true;
  const { searchParams } = new URL(request.url);
  return searchParams.get('secret') === CRON_SECRET;
}

export async function GET(request: Request) {
  if (!isAuthedCron(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return withCronRun('cal-reminder-1h', realHandler)(request);
}
