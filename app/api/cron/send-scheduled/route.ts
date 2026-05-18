import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendBroadcastEmail } from '@/lib/email';
import { withCronRun } from '@/lib/cronRun';

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

async function realHandler(_request: Request): Promise<{ status: 'success' | 'partial' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  let campaigns: any[] = [];
  try {
    const all = await getAllRecords(TABLES.CAMPAIGNS);
    campaigns = all.filter((c: any) => {
      const status = (c['Status'] || c['Campaign Status'] || '').toLowerCase();
      return status === 'scheduled';
    });
  } catch {
    return { status: 'success', recordsTouched: 0, notes: 'no campaigns table or no scheduled campaigns' };
  }

  const now = Date.now();
  const due = campaigns.filter((c: any) => {
    const scheduledFor = c['Scheduled For'];
    if (!scheduledFor) return false;
    return new Date(scheduledFor).getTime() <= now;
  });

  if (due.length === 0) {
    return { status: 'success', recordsTouched: 0, notes: 'no campaigns due' };
  }

  let totalSent = 0;
  let totalFailed = 0;
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
    totalFailed += failed;
  }

  return {
    status: totalFailed > 0 ? 'partial' : 'success',
    recordsTouched: totalSent,
    notes: `processed ${due.length} campaign(s), sent ${totalSent}, failed ${totalFailed}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const { CRON_SECRET } = await import('@/lib/secrets');
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    const url = new URL(request.url);
    const secret = url.searchParams.get('secret');
    if (secret !== CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  return withCronRun('send-scheduled', realHandler)(request);
}

export const GET = authedHandler;
