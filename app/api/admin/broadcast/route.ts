import { NextResponse } from 'next/server';
import { getAllRecords, createRecord, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendBroadcastEmail } from '@/lib/email';
import { requireAdmin } from '@/lib/adminAuth';
import { spamCheck } from '@/lib/spamCheck';

export const maxDuration = 60;

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getRecipients(audienceType: string, selectedStates?: string[]) {
  let recipients: Array<{ email: string; name: string }> = [];

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
    recipients = filtered.map((c: any) => ({
      email: (c['Email'] || '').trim().toLowerCase(),
      name: c['Full Name'] || 'Member',
    })).filter((r) => r.email);
  } else if (audienceType === 'ranchers') {
    const ranchers = await getAllRecords(TABLES.RANCHERS);
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

    if (!subject || !campaignName || (htmlBody ? false : !message)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const recipients = await getRecipients(audienceType, selectedStates);

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
        await createRecord(TABLES.CAMPAIGNS, {
          'Campaign Name': campaignName,
          'Subject': subject,
          'Message': message,
          'Audience': audienceType === 'consumers-by-state'
            ? `state:${selectedStates?.join(',')}`
            : audienceType,
          'Scheduled For': sendAt.toISOString(),
          'Status': 'Scheduled',
          'Recipients': recipients.length,
          'Include CTA': includeCTA || false,
          'CTA Text': ctaText || '',
          'CTA Link': ctaLink || '',
        });
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
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
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
    try {
      if (reservedCampaignId) {
        const { updateRecord } = await import('@/lib/airtable');
        await updateRecord(TABLES.CAMPAIGNS, reservedCampaignId, {
          'Status': failed > 0 ? 'Partial' : 'Sent',
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
          'Status': failed > 0 ? 'Partial' : 'Sent',
        });
      }
    } catch (campaignError) {
      console.error('Failed to log campaign (non-fatal):', campaignError);
    }

    return NextResponse.json({
      success: true,
      recipientCount: recipients.length,
      sent,
      failed,
      campaignName
    });
  } catch (error: any) {
    console.error('Error sending broadcast email:', error);
    return NextResponse.json({ error: error.message || 'Failed to send emails' }, { status: 500 });
  }
}


