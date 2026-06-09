import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { getAllRecords, getRecordById, updateRecord, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendOperatorPreCallBrief } from '@/lib/email';
import { logAuditEntry, buildAirtableUpdateReverse } from '@/lib/auditLog';

// Operator pre-call brief recipient. Falls back to BHC_OPERATOR_EMAIL env,
// then ADMIN_EMAIL env. If neither set, brief is skipped (non-fatal).
const OPERATOR_BRIEF_EMAIL =
  process.env.BHC_OPERATOR_EMAIL ||
  process.env.ADMIN_EMAIL ||
  '';

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
    const attendeeName = attendees.length > 0
      ? (attendees[0].name || '').toString().trim()
      : '';

    if (!attendeeEmail) {
      return NextResponse.json({ success: true, note: 'No attendee email found' });
    }

    // Hoisted up so the buyer-sales branch can include it in alerts.
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

    // Event type detection — Cal.com payload exposes the event slug under
    // multiple keys across versions. Try them all defensively. A slug
    // containing 'sales' (or title pattern) means this is a BUYER booking
    // Ben's sales-call event type — distinct from rancher migration calls.
    const eventTypeSlug = String(
      bookingPayload.eventType?.slug ||
      bookingPayload.type ||
      payload.payload?.eventType?.slug ||
      ''
    ).toLowerCase();
    const eventTitle = String(bookingPayload.title || bookingPayload.eventType?.title || '').toLowerCase();
    const isBuyerSalesCall =
      eventTypeSlug.includes('sales') ||
      /sales call|buyer.*call|reserve.*share/i.test(eventTitle);

    // ── BUYER SALES CALL (Operator tier) ──────────────────────────────
    // When eventType slug indicates sales call, look up the attendee in
    // Consumers (not Ranchers) and fire the pre-call brief + distinct
    // Telegram alert. Stamp Referral.Sales Call Booked At so we can
    // measure sales-call → close conversion later.
    if (isBuyerSalesCall) {
      try {
        // Find consumer by attendee email
        const consumers = await getAllRecords(
          TABLES.CONSUMERS,
          `LOWER({Email}) = "${escapeAirtableValue(attendeeEmail)}"`
        );
        const consumer: any = consumers.length > 0 ? consumers[0] : null;

        // Find active referral for this buyer (most-recent non-terminal)
        let referral: any = null;
        let rancher: any = null;
        let referralIdFromMetadata = '';
        try {
          referralIdFromMetadata = String(bookingPayload.metadata?.referralId || '').trim();
        } catch {}
        if (referralIdFromMetadata) {
          try {
            referral = await getRecordById(TABLES.REFERRALS, referralIdFromMetadata);
          } catch {
            // metadata referralId stale/wrong — fall through to lookup-by-buyer
          }
        }
        if (!referral && consumer) {
          const consumerRefs = await getAllRecords(
            TABLES.REFERRALS,
            `AND(SEARCH("${consumer.id}", ARRAYJOIN({Buyer})), NOT(OR({Status}="Closed Won",{Status}="Closed Lost")))`
          );
          // Pick most-recent (Airtable returns no guaranteed order — sort by Intro Sent At desc)
          referral = consumerRefs
            .sort((a, b) => String(b['Intro Sent At'] || '').localeCompare(String(a['Intro Sent At'] || '')))[0]
            || null;
        }
        if (referral) {
          const rancherLinks: string[] = referral['Rancher'] || referral['Suggested Rancher'] || [];
          if (rancherLinks[0]) {
            try {
              rancher = await getRecordById(TABLES.RANCHERS, rancherLinks[0]);
            } catch {}
          }
        }

        const buyerName = (consumer && (consumer['Full Name'] || consumer['Name'])) || attendeeName || attendeeEmail;
        const rancherName = rancher
          ? (rancher['Ranch Name'] || rancher['Operator Name'] || 'a rancher')
          : 'unknown rancher';
        const verb =
          triggerEvent === 'BOOKING_CREATED' ? '📅 BUYER SALES CALL'
          : triggerEvent === 'BOOKING_RESCHEDULED' ? '🔄 BUYER SALES CALL — rescheduled'
          : triggerEvent === 'BOOKING_CANCELLED' ? '❌ BUYER SALES CALL — cancelled'
          : triggerEvent === 'MEETING_ENDED' ? '✅ BUYER SALES CALL — ended'
          : `📅 ${triggerEvent}`;
        const meetingUrl = bookingPayload.metadata?.videoCallUrl || bookingPayload.location || '';

        // Telegram alert (distinct from rancher migration emoji set)
        try {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `${verb}\n\n` +
              `👤 <b>Buyer:</b> ${buyerName} (${attendeeEmail})\n` +
              `🤠 <b>Rancher:</b> ${rancherName}\n` +
              `🗓 ${dateDisplay} MT\n` +
              (referral ? `📎 Ref: ${referral.id} · ${referral['Status'] || '?'}` : '⚠️ No active referral matched — buyer may have booked off-funnel.') +
              (meetingUrl ? `\n🔗 ${meetingUrl}` : '')
          );
        } catch (e: any) {
          console.error('[cal webhook] buyer-sales Telegram failed:', e?.message);
        }

        // Stamp Referral.Sales Call Booked At on BOOKING_CREATED
        if (triggerEvent === 'BOOKING_CREATED' && referral) {
          try {
            const reverse = buildAirtableUpdateReverse(TABLES.REFERRALS, referral.id, {
              'Sales Call Booked At': referral['Sales Call Booked At'],
            });
            await updateRecord(TABLES.REFERRALS, referral.id, {
              'Sales Call Booked At': new Date().toISOString(),
            });
            await logAuditEntry({
              actor: 'cron',
              tool: 'cal-webhook-buyer-sales-booked',
              targetType: 'Referral',
              targetId: referral.id,
              args: { attendeeEmail, startTime, eventTypeSlug },
              result: { stamped: 'Sales Call Booked At' },
              reverseAction: reverse,
            });
          } catch (e: any) {
            console.warn('[cal webhook] Sales Call Booked At stamp failed (field may not exist):', e?.message);
          }
        }
        // Stamp Sales Call Completed At on MEETING_ENDED
        if (triggerEvent === 'MEETING_ENDED' && referral) {
          try {
            await updateRecord(TABLES.REFERRALS, referral.id, {
              'Sales Call Completed At': new Date().toISOString(),
            });
          } catch (e: any) {
            console.warn('[cal webhook] Sales Call Completed At stamp failed:', e?.message);
          }
        }

        // Fire pre-call brief to operator on BOOKING_CREATED
        if (triggerEvent === 'BOOKING_CREATED' && OPERATOR_BRIEF_EMAIL && referral) {
          try {
            // Parse Consumer.Quiz Answers if present (JSON-encoded)
            let quizAnswers: Record<string, string> = {};
            try {
              const raw = consumer?.['Quiz Answers'];
              if (raw && typeof raw === 'string') {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') quizAnswers = parsed;
              } else if (raw && typeof raw === 'object') {
                quizAnswers = raw as Record<string, string>;
              }
            } catch {}
            await sendOperatorPreCallBrief({
              recipientEmail: OPERATOR_BRIEF_EMAIL,
              buyerName: String(buyerName),
              buyerEmail: attendeeEmail,
              buyerPhone: consumer?.['Phone'] || undefined,
              buyerState: consumer?.['State'] || undefined,
              buyerCity: consumer?.['City'] || undefined,
              callTime: startTime,
              meetingUrl,
              rancherName: String(rancherName),
              rancherSlug: rancher?.['Slug'] || undefined,
              rancherTier: (() => {
                const t: any = rancher?.['Tier'];
                if (!t) return undefined;
                return typeof t === 'object' && 'name' in t ? String(t.name) : String(t);
              })(),
              quarterPrice: Number(rancher?.['Quarter Price']) || undefined,
              halfPrice: Number(rancher?.['Half Price']) || undefined,
              wholePrice: Number(rancher?.['Whole Price']) || undefined,
              nextProcessingDate: rancher?.['Next Processing Date'] || undefined,
              quizScore: Number(consumer?.['Quiz Score']) || undefined,
              quizAnswers,
              referralId: referral.id,
              referralStatus: referral['Status'] || undefined,
            });
          } catch (e: any) {
            console.error('[cal webhook] pre-call brief email failed:', e?.message);
          }
        }

        return NextResponse.json({
          success: true,
          event: triggerEvent,
          path: 'buyer-sales-call',
          rancher: rancherName,
          buyer: attendeeEmail,
          referralId: referral?.id,
        });
      } catch (e: any) {
        console.error('[cal webhook] buyer-sales branch error (falling through):', e?.message);
        // Fall through to legacy rancher-attendee path below if this branch
        // throws unexpectedly — prevents a buyer booking from black-holing.
      }
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

    // ── BUYER ↔ RANCHER BOOKING DETECTION (2026-06-03) ──────────────────
    // When a buyer self-schedules a call via the rancher's Cal.com link from
    // the intro email, the HOST is the rancher and the ATTENDEE is the buyer
    // (inverse of Ben's onboarding-call flow above). Detect by looking up
    // the organizer's email against the Ranchers table — if found AND the
    // attendee is NOT also a rancher, this is a buyer↔rancher booking.
    //
    // We don't mutate Onboarding Status for these — just emit a loud
    // Telegram alert so Ben sees every booking come through (visibility
    // mandate), and short-circuit before the onboarding-call status logic
    // runs (it would no-op anyway since the attendee isn't a rancher, but
    // explicit early-return prevents future drift).
    const organizerEmail = (
      bookingPayload.organizer?.email ||
      payload.organizer?.email ||
      ''
    ).toString().trim().toLowerCase();
    if (organizerEmail && !rancher) {
      let hostRanchers: any[] = [];
      try {
        hostRanchers = await getAllRecords(
          TABLES.RANCHERS,
          `LOWER({Email}) = "${escapeAirtableValue(organizerEmail)}"`
        );
      } catch (e) {
        console.error('[cal webhook] host-rancher lookup failed:', e);
      }
      if (hostRanchers.length > 0) {
        const hostRancher = hostRanchers[0];
        const hostName = hostRancher['Operator Name'] || hostRancher['Ranch Name'] || organizerEmail;
        const buyerDisplay = attendees[0]?.name || attendeeEmail;
        const eventTitle = bookingPayload.title || 'Buyer call';
        const meetingUrl = bookingPayload.metadata?.videoCallUrl || bookingPayload.location || '';
        const verb =
          triggerEvent === 'BOOKING_CREATED' ? '📅 NEW BOOKING'
          : triggerEvent === 'BOOKING_RESCHEDULED' ? '🔄 RESCHEDULED'
          : triggerEvent === 'BOOKING_CANCELLED' ? '❌ CANCELLED'
          : triggerEvent === 'MEETING_ENDED' ? '✅ CALL ENDED'
          : '📅 ' + triggerEvent;
        try {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `${verb} — Buyer ↔ Rancher\n\n` +
              `👤 <b>Buyer:</b> ${buyerDisplay} (${attendeeEmail})\n` +
              `🤠 <b>Rancher:</b> ${hostName}\n` +
              `🗓 ${dateDisplay}\n` +
              `🎯 ${eventTitle}` +
              (meetingUrl ? `\n🔗 ${meetingUrl}` : '')
          );
        } catch (e) {
          console.error('[cal webhook] buyer-rancher Telegram alert failed:', e);
        }
        // Stamp Conversations table so the booking shows up in the activity
        // feed for that rancher+buyer pair. Non-fatal — if the table or
        // fields don't match yet, just continue.
        try {
          const { createRecord } = await import('@/lib/airtable');
          await createRecord(TABLES.CONVERSATIONS, {
            'Channel': 'Cal.com',
            'Direction': 'system',
            'Sender Email': organizerEmail,
            'Recipient Email': attendeeEmail,
            'Subject': `${verb} — ${eventTitle}`,
            'Body': `Booking ${triggerEvent} at ${dateDisplay}.${meetingUrl ? ` Meeting: ${meetingUrl}` : ''}`,
            'Sent At': new Date().toISOString(),
          });
        } catch (e: any) {
          // Conversations schema may not include these exact field names —
          // OK to swallow. Telegram is the primary signal.
          console.warn('[cal webhook] buyer-rancher Conversations log skipped:', e?.message);
        }
        return NextResponse.json({
          success: true,
          event: triggerEvent,
          path: 'buyer-rancher',
          rancher: hostName,
          buyer: attendeeEmail,
        });
      }
    }

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
