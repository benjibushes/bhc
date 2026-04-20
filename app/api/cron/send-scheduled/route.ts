import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendBroadcastEmail } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';

export const maxDuration = 60;

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getRecipients(audienceType: string, selectedStates?: string[]) {
  let recipients: Array<{ email: string; name: string }> = [];

  // CRITICAL: filter out anyone who unsubscribed or hard-bounced. Sending to
  // them again is a CAN-SPAM violation AND tanks your sender reputation —
  // ISPs see repeated sends to known-bad addresses and start spam-foldering
  // the rest of your mail.
  const isMailable = (record: any): boolean => {
    if (record['Unsubscribed'] === true) return false;
    if (record['Bounced'] === true) return false;
    if (record['Complained'] === true) return false;
    return true;
  };

  if (audienceType === 'consumers' || audienceType.startsWith('state:')) {
    const consumers = await getAllRecords(TABLES.CONSUMERS);
    const stateList = audienceType.startsWith('state:') ? audienceType.replace('state:', '').split(',') : null;
    const filtered = (stateList
      ? consumers.filter((c: any) => stateList.includes(c['State']))
      : consumers
    ).filter(isMailable);
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

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      const url = new URL(request.url);
      const secret = url.searchParams.get('secret');
      if (secret !== process.env.CRON_SECRET && process.env.CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    let campaigns: any[] = [];
    try {
      const all = await getAllRecords(TABLES.CAMPAIGNS);
      campaigns = all.filter((c: any) => {
        const status = (c['Status'] || c['Campaign Status'] || '').toLowerCase();
        return status === 'scheduled';
      });
    } catch {
      return NextResponse.json({ message: 'No campaigns table or no scheduled campaigns', sent: 0 });
    }

    const now = Date.now();
    const due = campaigns.filter((c: any) => {
      const scheduledFor = c['Scheduled For'];
      if (!scheduledFor) return false;
      return new Date(scheduledFor).getTime() <= now;
    });

    if (due.length === 0) {
      return NextResponse.json({ message: 'No campaigns due', sent: 0 });
    }

    let totalSent = 0;
    for (const campaign of due) {
      const audienceType = campaign['Audience'] || 'consumers';
      const stateFilter = audienceType.startsWith('state:') ? audienceType.replace('state:', '').split(',') : undefined;
      const recipients = await getRecipients(audienceType, stateFilter);

      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
      const rawCtaLink = campaign['CTA Link'] || '/member';
      let fullCtaLink = rawCtaLink;
      if (campaign['Include CTA'] && rawCtaLink) {
        if (!rawCtaLink.startsWith('http')) {
          fullCtaLink = `${baseUrl}${rawCtaLink.startsWith('/') ? '' : '/'}${rawCtaLink}?campaign=${campaign['Campaign Name']}`;
        } else {
          fullCtaLink = `${rawCtaLink}${rawCtaLink.includes('?') ? '&' : '?'}campaign=${campaign['Campaign Name']}`;
        }
      }

      let sent = 0;
      let failed = 0;
      for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        const batch = recipients.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(recipient =>
            sendBroadcastEmail({
              to: recipient.email,
              name: recipient.name,
              subject: campaign['Subject'],
              message: campaign['Message'] || '',
              campaignName: campaign['Campaign Name'],
              includeCTA: campaign['Include CTA'] || false,
              ctaText: campaign['CTA Text'] || 'Learn More',
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

      try {
        await updateRecord(TABLES.CAMPAIGNS, campaign.id, {
          'Status': 'Sent',
          'Sent At': new Date().toISOString(),
          'Sent': sent,
          'Failed': failed,
        });
      } catch (e) {
        console.error('Failed to update campaign status:', e);
      }

      totalSent += sent;
    }

    return NextResponse.json({ message: `Processed ${due.length} campaign(s)`, totalSent });
  } catch (error: any) {
    console.error('Cron send-scheduled error:', error);
    await sendTelegramUpdate(`⚠️ Send-scheduled cron failed: ${error.message}`).catch(() => {});
    return NextResponse.json({ error: error.message || 'Internal error' }, { status: 500 });
  }
}
