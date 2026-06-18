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

async function getRecipients(audienceType: string, _selectedStates?: string[]) {
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

  // Audience tokens — must match what the write path (app/api/admin/broadcast/route.ts)
  // serializes into the Campaigns.Audience field:
  //   - 'consumers'            (all consumers)
  //   - 'consumers-beef'       (Segment='Beef Buyer')
  //   - 'consumers-community'  (Segment blank or 'Community')
  //   - 'state:CA,TX,...'      (consumers-by-state, serialized from selectedStates)
  //   - 'ranchers'             (all ranchers)
  if (
    audienceType === 'consumers' ||
    audienceType === 'consumers-beef' ||
    audienceType === 'consumers-community' ||
    audienceType.startsWith('state:')
  ) {
    const consumers = await getAllRecords(TABLES.CONSUMERS);
    let filtered: any[] = consumers;
    if (audienceType.startsWith('state:')) {
      const stateList = audienceType.replace('state:', '').split(',').map(s => s.trim()).filter(Boolean);
      filtered = consumers.filter((c: any) => stateList.includes(c['State']));
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
    const recipients = await getRecipients(audienceType);

    // Flip Status='Sending' BEFORE the send loop. If the cron crashes mid-send,
    // the next tick won't re-pick this row (filter is Status='scheduled'). This
    // prevents double-sending the whole audience after a partial crash.
    try {
      await updateRecord(TABLES.CAMPAIGNS, campaign.id, {
        'Status': 'Sending',
      });
    } catch (e) {
      console.error('Failed to reserve campaign before send:', e);
      // If we can't reserve, skip rather than risk double-send on retry.
      continue;
    }

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

    // Read the HTML body saved at scheduling time (if any). Defensive: the
    // field may not exist if this is an old record or the table schema hasn't
    // been updated yet — fall back to undefined so plain-text path is used.
    const htmlBody: string | undefined =
      typeof campaign['HTML Body'] === 'string' && campaign['HTML Body'].trim()
        ? campaign['HTML Body']
        : undefined;

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
            // Pass htmlBody so Custom-HTML campaigns render correctly.
            // When htmlBody is set, the email lib uses it as the full email
            // body and suppresses the CTA button (same as immediate-send path).
            htmlBody,
            includeCTA: htmlBody ? false : (campaign['Include CTA'] || false),
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

    // Mirror the immediate-send path in /api/admin/broadcast: flip to 'Partial'
    // if any failures occurred, else 'Sent'. Operators rely on this status to
    // know whether to investigate Resend failures or move on.
    const finalStatus = failed > 0 ? 'Partial' : 'Sent';
    try {
      await updateRecord(TABLES.CAMPAIGNS, campaign.id, {
        'Status': finalStatus,
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
