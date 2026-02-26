import { NextResponse } from 'next/server';
import { getAllRecords, createRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendBroadcastEmail } from '@/lib/email';

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
    const body = await request.json();
    const { subject, message, campaignName, audienceType, selectedStates, includeCTA, ctaText, ctaLink, preview, scheduledFor } = body;

    if (!subject || !message || !campaignName) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const recipients = await getRecipients(audienceType, selectedStates);

    if (recipients.length === 0) {
      return NextResponse.json({ error: 'No recipients found' }, { status: 400 });
    }

    if (preview) {
      return NextResponse.json({
        preview: true,
        recipientCount: recipients.length,
        sampleRecipients: recipients.slice(0, 10).map(r => ({ name: r.name, email: r.email.replace(/(.{2}).*(@.*)/, '$1***$2') })),
        subject,
        campaignName,
      });
    }

    // Duplicate campaign protection
    try {
      const existing = await getAllRecords(TABLES.CAMPAIGNS, `{Campaign Name} = "${campaignName}"`);
      if (existing.length > 0) {
        return NextResponse.json({ error: `Campaign "${campaignName}" has already been sent. Use a different campaign name.` }, { status: 409 });
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
            message,
            campaignName,
            includeCTA,
            ctaText: ctaText || 'Learn More',
            ctaLink: fullCtaLink,
          })
        )
      );
      sent += results.filter(r => r.status === 'fulfilled' && (r.value as any)?.success).length;
      failed += results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !(r.value as any)?.success)).length;

      if (i + BATCH_SIZE < recipients.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    // Log campaign to Airtable
    try {
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
      });
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


