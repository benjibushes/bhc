import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';

export const maxDuration = 60;

// P1 audit D-5: date filter + per-Source attribution breakdown.
// Closest thing to per-channel CAC w/o Meta Ads spend integration.
// Query param: ?sinceDays=7|30|90|all (default 'all' for backward compat).

export async function GET(request: Request) {
  try {
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;

    const url = new URL(request.url);
    const sinceParam = (url.searchParams.get('sinceDays') || 'all').toLowerCase();
    const sinceDays = sinceParam === 'all' ? null : Math.max(1, Math.min(365, Number(sinceParam) || 0));
    const cutoff = sinceDays ? Date.now() - sinceDays * 86400000 : 0;
    const withinRange = (iso: any): boolean => {
      if (!sinceDays) return true;
      if (!iso) return false;
      const t = new Date(iso).getTime();
      return Number.isFinite(t) && t >= cutoff;
    };

    const consumers = await getAllRecords(TABLES.CONSUMERS);
    const inquiries = await getAllRecords(TABLES.INQUIRIES);
    const campaigns = await getAllRecords(TABLES.CAMPAIGNS);

    let referrals: any[] = [];
    try {
      referrals = await getAllRecords(TABLES.REFERRALS);
    } catch {
      // Referrals table may not exist yet
    }

    // Apply date filter — fall back to including the row if it has no Created
    // when sinceDays is 'all' (legacy rows pre-Created field).
    const consumersInRange = consumers.filter((c: any) => withinRange(c['Created']));
    const inquiriesInRange = inquiries.filter((i: any) => withinRange(i['Created']));
    const referralsInRange = referrals.filter((r: any) => withinRange(r['Created At'] || r['Created']));

    const completedSales = inquiriesInRange.filter((i: any) => i['Status'] === 'Sale Completed');
    const totalSales = completedSales.length;
    const totalRevenue = completedSales.reduce((sum: number, i: any) => {
      return sum + (parseFloat(i['Sale Amount'] || '0'));
    }, 0);
    const totalCommission = completedSales.reduce((sum: number, i: any) => {
      return sum + (parseFloat(i['Commission Amount'] || '0'));
    }, 0);
    const conversionRate = inquiriesInRange.length > 0 ? totalSales / inquiriesInRange.length : 0;

    const campaignStats: any[] = [];
    const campaignMap = new Map();

    campaigns.forEach((c: any) => {
      const name = c['Campaign Name'];
      if (name) {
        campaignMap.set(name, {
          campaignName: name,
          emailsSent: parseInt(c['Recipients Count'] || '0'),
          signUps: 0,
          inquiries: 0,
          sales: 0,
          totalRevenue: 0,
          totalCommission: 0,
        });
      }
    });

    consumersInRange.forEach((c: any) => {
      const campaign = c['Campaign'];
      if (campaign && campaignMap.has(campaign)) {
        const stats = campaignMap.get(campaign);
        stats.signUps++;
      }
    });

    inquiriesInRange.forEach((i: any) => {
      const source = i['Source'];
      if (source && campaignMap.has(source)) {
        const stats = campaignMap.get(source);
        stats.inquiries++;
        if (i['Status'] === 'Sale Completed') {
          stats.sales++;
          stats.totalRevenue += parseFloat(i['Sale Amount'] || '0');
          stats.totalCommission += parseFloat(i['Commission Amount'] || '0');
        }
      }
    });

    campaignStats.push(...Array.from(campaignMap.values()));

    // P1 audit D-5: per-Source attribution. Buckets Consumers by their Source
    // field (organic / rancher-page / exit-intent / partner-XXX /
    // rancher-<slug>) and traces them through to matches and closes via the
    // Referrals + Closed Won pipeline. Sortable by closed-won $ — Ben's
    // closest signal to per-channel CAC w/o spend data.
    const sourceMap = new Map<string, {
      source: string;
      signups: number;
      matches: number;
      closes: number;
      commissionDue: number;
    }>();
    const bucket = (key: string) => {
      if (!sourceMap.has(key)) {
        sourceMap.set(key, { source: key, signups: 0, matches: 0, closes: 0, commissionDue: 0 });
      }
      return sourceMap.get(key)!;
    };

    // Index Consumers by id to map referrals back to their Source.
    const consumerSourceById = new Map<string, string>();
    consumersInRange.forEach((c: any) => {
      const source = (c['Source'] || 'organic').toString().trim() || 'organic';
      bucket(source).signups++;
      if (c.id) consumerSourceById.set(c.id, source);
    });

    // Walk Referrals — link to Buyer to get Source. If a referral has no
    // linked buyer or the buyer was created outside the range, skip.
    referralsInRange.forEach((r: any) => {
      const buyerIds = r['Buyer'] || [];
      const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
      if (!buyerId) return;
      const source = consumerSourceById.get(buyerId);
      if (!source) return;
      const status = r['Status'] || '';
      // Active referral counts as "matched" if it's past Pending Approval
      if (status && status !== 'Pending Approval') {
        bucket(source).matches++;
      }
      if (status === 'Closed Won') {
        bucket(source).closes++;
        bucket(source).commissionDue += Number(r['Commission Due'] || 0);
      }
    });

    const sourceBreakdown = Array.from(sourceMap.values())
      .sort((a, b) => b.commissionDue - a.commissionDue);

    const recentActivity: any[] = [];

    consumersInRange
      .slice(-10)
      .reverse()
      .forEach((c: any) => {
        recentActivity.push({
          type: 'signup',
          name: c['Full Name'] || 'Unknown',
          details: `Applied for access in ${c['State'] || 'Unknown'}`,
          source: c['Campaign'] || c['Source'] || 'organic',
          date: c['Created'] || new Date().toISOString(),
        });
      });

    inquiriesInRange
      .filter((i: any) => i['Status'] !== 'Pending')
      .slice(-5)
      .reverse()
      .forEach((i: any) => {
        recentActivity.push({
          type: 'inquiry',
          name: i['Consumer Name'] || 'Unknown',
          details: `Inquired about ${i['Ranch Name'] || 'a ranch'}`,
          source: i['Source'] || 'organic',
          date: i['Created'] || new Date().toISOString(),
        });
      });

    completedSales
      .slice(-5)
      .reverse()
      .forEach((i: any) => {
        recentActivity.push({
          type: 'sale',
          name: i['Consumer Name'] || 'Unknown',
          details: `Purchased from ${i['Ranch Name'] || 'a ranch'}`,
          source: i['Source'] || 'organic',
          amount: parseFloat(i['Commission Amount'] || '0'),
          date: i['Created'] || new Date().toISOString(),
        });
      });

    // Sort activity by date
    recentActivity.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Referral analytics — date-filtered
    const closedWon = referralsInRange.filter((r: any) => r['Status'] === 'Closed Won');
    const refRevenue = closedWon.reduce((s: number, r: any) => s + (r['Sale Amount'] || 0), 0);
    const refCommission = closedWon.reduce((s: number, r: any) => s + (r['Commission Due'] || 0), 0);
    const pendingReferrals = referralsInRange.filter((r: any) => r['Status'] === 'Pending Approval').length;
    const activeReferrals = referralsInRange.filter((r: any) =>
      !['Closed Won', 'Closed Lost', 'Dormant'].includes(r['Status'])
    ).length;

    const avgTimeToClose = closedWon.length > 0
      ? closedWon.reduce((s: number, r: any) => {
          const created = r['Created At'] ? new Date(r['Created At']).getTime() : 0;
          const closed = r['Closed At'] ? new Date(r['Closed At']).getTime() : 0;
          return s + (closed && created ? (closed - created) / 86400000 : 0);
        }, 0) / closedWon.length
      : 0;

    // Intent score correlation
    const highIntentClosed = closedWon.filter((r: any) => r['Intent Classification'] === 'High').length;
    const highIntentTotal = referralsInRange.filter((r: any) => r['Intent Classification'] === 'High').length;
    const medIntentClosed = closedWon.filter((r: any) => r['Intent Classification'] === 'Medium').length;
    const medIntentTotal = referralsInRange.filter((r: any) => r['Intent Classification'] === 'Medium').length;

    // Revenue by state
    const revenueByState: Record<string, number> = {};
    closedWon.forEach((r: any) => {
      const state = r['Buyer State'] || 'Unknown';
      revenueByState[state] = (revenueByState[state] || 0) + (r['Sale Amount'] || 0);
    });
    const revenueByStateArr = Object.entries(revenueByState)
      .map(([state, revenue]) => ({ state, revenue }))
      .sort((a, b) => b.revenue - a.revenue);

    return NextResponse.json({
      // Echo the filter so the UI can show "Last 7 days" etc.
      filter: { sinceDays, label: sinceDays ? `Last ${sinceDays}d` : 'All time' },
      overview: {
        totalConsumers: consumersInRange.length,
        totalInquiries: inquiriesInRange.length,
        totalSales,
        totalRevenue: totalRevenue + refRevenue,
        totalCommission: totalCommission + refCommission,
        conversionRate,
      },
      referralStats: {
        total: referralsInRange.length,
        pending: pendingReferrals,
        active: activeReferrals,
        closedWon: closedWon.length,
        closedLost: referralsInRange.filter((r: any) => r['Status'] === 'Closed Lost').length,
        revenue: refRevenue,
        commission: refCommission,
        avgDaysToClose: Math.round(avgTimeToClose),
        intentCorrelation: {
          high: { closed: highIntentClosed, total: highIntentTotal, rate: highIntentTotal > 0 ? highIntentClosed / highIntentTotal : 0 },
          medium: { closed: medIntentClosed, total: medIntentTotal, rate: medIntentTotal > 0 ? medIntentClosed / medIntentTotal : 0 },
        },
        revenueByState: revenueByStateArr,
      },
      campaigns: campaignStats,
      sourceBreakdown,
      recentActivity: recentActivity.slice(0, 20),
    });
  } catch (error: any) {
    console.error('Error fetching analytics:', error);
    return NextResponse.json({ error: error.message || 'Failed to fetch analytics' }, { status: 500 });
  }
}
