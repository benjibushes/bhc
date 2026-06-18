import { NextResponse } from 'next/server';
import { getAllRecords, createRecord, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendBroadcastEmail } from '@/lib/email';
import { requireAdmin } from '@/lib/adminAuth';
import { spamCheck } from '@/lib/spamCheck';
import { logAuditEntry } from '@/lib/auditLog';

export const maxDuration = 60;

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getRecipients(audienceType: string, selectedStates?: string[]) {
  let recipients: Array<{ email: string; name: string }> = [];

  // CRITICAL: filter out anyone who unsubscribed or hard-bounced/complained.
  // Sending to them again is a CAN-SPAM violation AND tanks sender reputation.
  // This MUST match the cron path's isMailable (app/api/cron/send-scheduled/route.ts) —
  // the immediate-send path previously skipped this filter, so an operator hitting
  // "Send now" could blast unsubscribed addresses the scheduled path would have spared.
  const isMailable = (record: any): boolean => {
    if (record['Unsubscribed'] === true) return false;
    if (record['Bounced'] === true) return false;
    if (record['Complained'] === true) return false;
    return true;
  };

  if (audienceType === 'consumers' || audienceType === 'consumers-by-state' || audienceType === 'consumers-beef' || audienceType === 'consumers-community') {
    const consumers = await getAllRecords(TABLES.CONSUMERS);
    let filtered = consumers;
    if (audienceType === 'consumers-by-state') {
      filtered = consumers.filter((c: any) => selectedStates?.includes(c['State']));
    } else if (audienceType === 'consumers-beef') {
      filtered = consumers.filter((c: any) => c['Segment'] === 'Beef Buyer');
    } else if (audienceType === 'consumers-community') {
      filtered = consumers.filter((c: any) => !c['Segment'] || c['Segment'] === 'Community');
    }
    filtered = filtered.filter(isMailable);
    recipients = filtered.map((c: any) => ({
      email: (c['Email'] || '').trim().toLowerCase(),
      name: c['Full Name'] || 'Member',
    })).filter((r) => r.email);
  } else if (audienceType === 'ranchers') {
    const ranchers = (await getAllRecords(TABLES.RANCHERS)).filter(isMailable);
    recipients = ranchers.map((r: any) => ({
      email: (r['Email'] || '').trim().toLowerCase(),
      name: r['Operator Name'] || 'Rancher',
    })).filter((r) => r.email);
  }

  const seen = new Set<string>();
  return recipients.filter(r => {
    if (seen.has(r.email)) return false;
    seen.add(r.email);
    return true;
  });
}

export async function POST(request: Request) {
  try {
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;
    const body = await request.json();
    const { subject, message, htmlBody, campaignName, audienceType, selectedStates, includeCTA, ctaText, ctaLink, preview, scheduledFor } = body;
    // Explicit single/targeted recipient path (admin-gated above). The
    // compliance per-rancher "Send Reminder" button POSTs
    // { recipients: [{ email, name }] } with no audienceType — pre-fix
    // getRecipients() saw no audienceType, returned [], and the route 400'd
    // "No recipients found". When an explicit recipients[] is supplied we send
    // to exactly those addresses (sanitized + deduped) instead of building an
    // audience. Audience-based sends are unchanged.
    const explicitRecipients: Array<{ email: string; name: string }> | null =
      Array.isArray(body?.recipients)
        ? (body.recipients as any[])
            .map((r) => ({
              email: String(r?.email || '').trim().toLowerCase(),
              name: String(r?.name || '').trim() || 'there',
            }))
            .filter((r) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email))
        : null;

    if (!subject || !campaignName || (htmlBody ? false : !message)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    let recipients: Array<{ email: string; name: string }>;
    if (explicitRecipients !== null) {
      // Dedupe explicit list by email (same shape getRecipients returns).
      const seen = new Set<string>();
      recipients = explicitRecipients.filter((r) => {
        if (seen.has(r.email)) return false;
        seen.add(r.email);
        return true;
      });
    } else {
      recipients = await getRecipients(audienceType, selectedStates);
    }

    if (recipients.length === 0) {
      return NextResponse.json({ error: 'No recipients found' }, { status: 400 });
    }

    // Spam-word scrub. P0 audit fix (C-3): we surface the score on PREVIEW
    // so operator sees it before confirming, and we HARD-BLOCK on send if
    // either subject or body scores >= 50. Better one false-positive than
    // a Resend blacklist that kills transactional refund + intro emails.
    const subjectCheck = spamCheck(subject);
    const bodyText = htmlBody || message || '';
    const bodyCheck = spamCheck(bodyText);
    const spamScore = Math.max(subjectCheck.score, bodyCheck.score);
    const spamViolations = [
      ...subjectCheck.violations.map((v) => `subject: ${v}`),
      ...bodyCheck.violations.map((v) => `body: ${v}`),
    ];

    if (preview) {
      return NextResponse.json({
        preview: true,
        recipientCount: recipients.length,
        sampleRecipients: recipients.slice(0, 10).map(r => ({ name: r.name, email: r.email.replace(/(.{2}).*(@.*)/, '$1***$2') })),
        subject,
        campaignName,
        spamScore,
        spamViolations,
        spamBlocked: spamScore >= 50,
      });
    }

    if (spamScore >= 50) {
      return NextResponse.json({
        error: 'Broadcast blocked by spam check',
        spamScore,
        spamViolations,
      }, { status: 400 });
    }

    // Duplicate campaign protection. Now checks for ANY prior row with the
    // same Campaign Name — including ones in Status='Sending' (a crashed
    // mid-flight broadcast we should NOT silently retry). Prior bug: dupe
    // check existed but the Campaigns row was only logged AFTER the full send
    // loop completed (~17min for large lists), so a crash before logging
    // bypassed the dupe gate on the next attempt → operator double-sent half
    // the audience.
    try {
      const existing = await getAllRecords(TABLES.CAMPAIGNS, `{Campaign Name} = "${escapeAirtableValue(campaignName)}"`);
      if (existing.length > 0) {
        const first = existing[0] as any;
        const status = String(first['Status'] || first['status'] || 'Sent');
        return NextResponse.json({
          error: `Campaign "${campaignName}" already exists (Status: ${status}). Use a different campaign name${status === 'Sending' ? ' — the prior run is mid-flight or crashed' : ''}.`,
        }, { status: 409 });
      }
    } catch {
      // If campaigns table doesn't exist, skip dupe check
    }

    // Schedule for later instead of sending now
    if (scheduledFor) {
      const sendAt = new Date(scheduledFor);
      if (sendAt.getTime() <= Date.now()) {
        return NextResponse.json({ error: 'Scheduled time must be in the future' }, { status: 400 });
      }
      try {
        // BUG FIX: persist htmlBody so the send-scheduled cron can read it.
        // Previously, Custom-HTML campaigns stored the HTML body nowhere on the
        // Campaigns row — the cron called sendBroadcastEmail with htmlBody=undefined
        // and the plain-text fallback produced a blank email.
        const scheduleFields: Record<string, any> = {
          'Campaign Name': campaignName,
          'Subject': subject,
          'Message': message || '',
          'Audience': audienceType === 'consumers-by-state'
            ? `state:${selectedStates?.join(',')}`
            : audienceType,
          'Scheduled For': sendAt.toISOString(),
          'Status': 'Scheduled',
          'Recipients': recipients.length,
          'Include CTA': includeCTA || false,
          'CTA Text': ctaText || '',
          'CTA Link': ctaLink || '',
        };
        // Write the HTML body field defensively — if the Airtable table doesn't
        // have the "HTML Body" field yet the entire createRecord will fail, so
        // we only add it when there is actually HTML to save.
        if (htmlBody) {
          scheduleFields['HTML Body'] = htmlBody;
        }
        await createRecord(TABLES.CAMPAIGNS, scheduleFields);
      } catch (e) {
        console.error('Failed to schedule campaign:', e);
        return NextResponse.json({ error: 'Failed to schedule campaign' }, { status: 500 });
      }
      return NextResponse.json({
        success: true,
        scheduled: true,
        scheduledFor: sendAt.toISOString(),
        recipientCount: recipients.length,
        campaignName,
      });
    }

    // Build CTA link with campaign tracking
    let fullCtaLink = ctaLink;
    if (includeCTA && ctaLink) {
      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
      if (!ctaLink.startsWith('http')) {
        fullCtaLink = `${baseUrl}${ctaLink.startsWith('/') ? '' : '/'}${ctaLink}?campaign=${campaignName}`;
      } else {
        fullCtaLink = `${ctaLink}${ctaLink.includes('?') ? '&' : '?'}campaign=${campaignName}`;
      }
    }

    // RESERVE the Campaigns row BEFORE sending. If the route crashes mid-send,
    // this row persists with Status='Sending' so the dupe gate above catches
    // any retry. End-of-loop update flips Status='Sent' (or 'Partial' if
    // any failures). Reservation failure is non-fatal — we still send.
    let reservedCampaignId: string | null = null;
    try {
      const reserved: any = await createRecord(TABLES.CAMPAIGNS, {
        'Campaign Name': campaignName,
        'Subject': subject,
        'Audience': audienceType === 'consumers-by-state'
          ? `state:${selectedStates?.join(',')}`
          : audienceType,
        'Sent At': new Date().toISOString(),
        'Recipients': recipients.length,
        'Status': 'Sending',
        'Sent': 0,
        'Failed': 0,
      });
      reservedCampaignId = reserved?.id || null;
    } catch (e: any) {
      console.warn('[broadcast] campaign reservation skipped:', e?.message);
    }

    // Batch send with rate limiting
    let sent = 0;
    let failed = 0;
    let aborted = false;
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      // Abort kill-switch. P0 audit fix (C-4): poll the reserved Campaigns
      // row at each batch boundary. If operator hit POST /api/admin/broadcast/abort,
      // Status flips to 'Aborting' and we bail out. Skipped if reservation
      // failed (no row to poll).
      if (reservedCampaignId) {
        try {
          const { getRecordById } = await import('@/lib/airtable');
          const row: any = await getRecordById(TABLES.CAMPAIGNS, reservedCampaignId);
          if (row && (row['Status'] || '') === 'Aborting') {
            aborted = true;
            break;
          }
        } catch (pollErr) {
          // Non-fatal — if Airtable read fails, keep sending. The dupe gate
          // protects against the next run if we crash anyway.
          console.warn('[broadcast] abort poll failed (continuing):', pollErr);
        }
      }

      const batch = recipients.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(recipient =>
          sendBroadcastEmail({
            to: recipient.email,
            name: recipient.name,
            subject,
            message: message || '',
            campaignName,
            includeCTA: htmlBody ? false : includeCTA,
            ctaText: ctaText || 'Learn More',
            ctaLink: fullCtaLink,
            htmlBody: htmlBody || undefined,
          })
        )
      );
      sent += results.filter(r => r.status === 'fulfilled' && (r.value as any)?.success).length;
      failed += results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !(r.value as any)?.success)).length;

      if (i + BATCH_SIZE < recipients.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    // Finalize the reserved Campaigns row — flip Status, write final counts.
    // If reservation failed earlier, fall back to creating a fresh row so we
    // still have an audit trail (with the caveat that dupe protection won't
    // catch a crashed retry in that fallback path).
    const finalStatus = aborted ? 'Aborted' : (failed > 0 ? 'Partial' : 'Sent');
    try {
      if (reservedCampaignId) {
        const { updateRecord } = await import('@/lib/airtable');
        await updateRecord(TABLES.CAMPAIGNS, reservedCampaignId, {
          'Status': finalStatus,
          'Sent': sent,
          'Failed': failed,
        });
      } else {
        await createRecord(TABLES.CAMPAIGNS, {
          'Campaign Name': campaignName,
          'Subject': subject,
          'Audience': audienceType === 'consumers-by-state'
            ? `state:${selectedStates?.join(',')}`
            : audienceType,
          'Sent At': new Date().toISOString(),
          'Recipients': recipients.length,
          'Sent': sent,
          'Failed': failed,
          'Status': finalStatus,
        });
      }
    } catch (campaignError) {
      console.error('Failed to log campaign (non-fatal):', campaignError);
    }

    // P1 audit D-3: log the broadcast-send. Emails can't be un-sent — reverseAction=noop.
    try {
      await logAuditEntry({
        actor: 'manual',
        tool: 'admin-broadcast-send',
        targetType: 'Other',
        targetId: reservedCampaignId || campaignName,
        args: { campaignName, subject, audienceType, selectedStates, includeCTA, ctaText, ctaLink, recipientCount: recipients.length },
        result: { sent, failed, aborted, finalStatus, recipientCount: recipients.length },
        reverseAction: { type: 'noop', reason: `Broadcast emails cannot be un-sent — ${sent} delivered.` },
      });
    } catch (e: any) {
      console.error('[broadcast] audit log failed (non-fatal):', e?.message);
    }

    return NextResponse.json({
      success: true,
      aborted,
      recipientCount: recipients.length,
      sent,
      failed,
      campaignName,
    });
  } catch (error: any) {
    console.error('Error sending broadcast email:', error);
    return NextResponse.json({ error: error.message || 'Failed to send emails' }, { status: 500 });
  }
}


