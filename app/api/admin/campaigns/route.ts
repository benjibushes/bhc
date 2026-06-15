// app/api/admin/campaigns/route.ts
//
// GET — read-only campaign history for the campaign console
// (/admin/campaigns). Lists every Campaigns row newest-first and, for each,
// computes engagement (delivered / opened / clicked) by querying the
// Email Sends table on its `Campaign` attribution field.
//
// Excludes two kinds of non-campaign rows that ride the Campaigns table:
//   1. The aiMemory KV row (Campaign Name === MEMORY_RECORD_NAME) — a
//      cross-conversation memory store, not a campaign (see lib/aiMemory.ts).
//   2. Single-recipient sends (Audience starts with `single:`) — one-off
//      operator emails, noise in a campaign history view.
//
// Auth: requireAdmin, mirroring app/api/admin/migration/route.ts.

import { NextResponse, NextRequest } from 'next/server';
import { getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';
import { MEMORY_RECORD_NAME } from '@/lib/aiMemory';

export const maxDuration = 60;

interface CampaignSummary {
  id: string;
  name: string;
  audience: string;
  status: string;
  scheduledFor: string;
  sentAt: string;
  recipients: number;
  sent: number;
  failed: number;
  delivered: number;
  opened: number;
  clicked: number;
  openRate: number;
  clickRate: number;
}

export async function GET(request: NextRequest) {
  const __authResp = await requireAdmin(request);
  if (__authResp) return __authResp;

  try {
    const all: any[] = await getAllRecords(TABLES.CAMPAIGNS);

    // Filter out the non-campaign rows (aiMemory KV + single-recipient sends).
    const campaigns = all.filter((c: any) => {
      const name = String(c['Campaign Name'] || '');
      if (!name) return false;
      if (name === MEMORY_RECORD_NAME) return false;
      const audience = String(c['Audience'] || '');
      if (audience.startsWith('single:')) return false;
      return true;
    });

    // Newest-first. Prefer Sent At, fall back to Scheduled For, then Created.
    const sortKey = (c: any): number => {
      const raw = c['Sent At'] || c['Scheduled For'] || c['Created'] || c._createdTime || '';
      const t = new Date(raw).getTime();
      return Number.isFinite(t) ? t : 0;
    };
    campaigns.sort((a, b) => sortKey(b) - sortKey(a));

    // For each campaign, count engagement on its Email Sends rows. We query
    // per-campaign on {Campaign} = "<name>" so this scales without pulling
    // the entire Email Sends table into memory. Delivered/opened/clicked are
    // stamped by the Resend webhook (app/api/webhooks/resend/route.ts).
    const summaries: CampaignSummary[] = await Promise.all(
      campaigns.map(async (c: any): Promise<CampaignSummary> => {
        const name = String(c['Campaign Name']);
        let delivered = 0;
        let opened = 0;
        let clicked = 0;
        try {
          const sends = (await getAllRecords(
            TABLES.EMAIL_SENDS,
            `{Campaign} = "${escapeAirtableValue(name)}"`,
          )) as any[];
          for (const s of sends) {
            if (s['Delivered At']) delivered++;
            if (s['Opened At']) opened++;
            if (s['Clicked At']) clicked++;
          }
        } catch (e: any) {
          // Non-fatal: a campaign with no attributed sends (or an Airtable
          // hiccup) just shows zero engagement rather than 500ing the page.
          console.warn(`[campaigns] engagement read failed for "${name}":`, e?.message);
        }

        // Open/click rates are denominated on DELIVERED (industry standard),
        // falling back to 0 when nothing delivered yet.
        const openRate = delivered > 0 ? opened / delivered : 0;
        const clickRate = delivered > 0 ? clicked / delivered : 0;

        return {
          id: c.id,
          name,
          audience: String(c['Audience'] || ''),
          status: String(c['Status'] || ''),
          scheduledFor: c['Scheduled For'] || '',
          sentAt: c['Sent At'] || '',
          recipients: Number(c['Recipients'] || 0),
          sent: Number(c['Sent'] || 0),
          failed: Number(c['Failed'] || 0),
          delivered,
          opened,
          clicked,
          openRate,
          clickRate,
        };
      }),
    );

    return NextResponse.json({ campaigns: summaries });
  } catch (error: any) {
    console.error('Error fetching campaigns:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to fetch campaigns' },
      { status: 500 },
    );
  }
}
