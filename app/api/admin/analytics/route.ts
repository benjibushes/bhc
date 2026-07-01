import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { requireRole } from '@/lib/adminAuth';
import { getSpendInRange } from '@/lib/adSpend';
import { deriveSalesMetrics, isLegacyInquirySale } from '@/lib/salesMetrics';

export const maxDuration = 60;

// P1 audit D-5: date filter + per-Source attribution breakdown.
// Closest thing to per-channel CAC w/o Meta Ads spend integration.
// Query param: ?sinceDays=7|30|90|all (default 'all' for backward compat).

export async function GET(request: Request) {
  try {
    // Opened to 'ads' partner: read-only buyer/funnel analytics.
    const __authResp = await requireRole(request, ['admin', 'ads']);
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
    const consumersInRange = consumers.filter((c: any) => withinRange(c['Created'] || c._createdTime));
    const inquiriesInRange = inquiries.filter((i: any) => withinRange(i['Created'] || i._createdTime));
    const referralsInRange = referrals.filter((r: any) => withinRange(r['Created At'] || r['Created'] || r._createdTime));

    // Legacy Inquiries "Sale Completed" path (pre-tier_v2 / manual closes) —
    // still used below for campaign attribution + the activity feed.
    const completedSales = inquiriesInRange.filter(isLegacyInquirySale);

    // B4: the tier_v2 deposit funnel writes SALES to Referrals (+ Payments),
    // NOT Inquiries — so the headline numbers read ~0 the moment ads drive
    // deposit-flow sales unless Referrals are counted. All derivation lives in
    // lib/salesMetrics (pure, unit-tested): a referral is a sale once the
    // deposit landed ('Deposit Paid At') OR it reached 'Closed Won', counted
    // exactly ONCE — the previous inline math re-added the Closed Won slice on
    // top of referral revenue/commission, near-doubling both the moment the
    // first funnel deal closed. Conversion = sales per funnel LEAD (consumers).
    const sales = deriveSalesMetrics(inquiriesInRange, referralsInRange, consumersInRange.length);

    const campaignStats: any[] = [];
    const campaignMap = new Map();

    campaigns.forEach((c: any) => {
      const name = c['Campaign Name'];
      if (name) {
        campaignMap.set(name, {
          campaignName: name,
          // Field is `Recipients` (not `Recipients Count`) — the prior name
          // never existed in the Campaigns schema, so emailsSent was always 0.
          emailsSent: parseInt(c['Recipients'] || '0'),
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
      saleRevenue: number;
    }>();
    const bucket = (key: string) => {
      if (!sourceMap.has(key)) {
        sourceMap.set(key, { source: key, signups: 0, matches: 0, closes: 0, commissionDue: 0, saleRevenue: 0 });
      }
      return sourceMap.get(key)!;
    };

    // Index Consumers by id to map referrals back to their Source.
    // ROAS fix: the source map must cover ALL consumers (all-time), not just
    // those created in-range. A close inside the range whose buyer signed up
    // BEFORE the window would otherwise be dropped (consumerSourceById.get
    // returns undefined → the close is silently uncounted → ROAS under-reports).
    // Mirrors command-center route (~232-237). Signups still count in-range only.
    const consumerSourceById = new Map<string, string>();
    consumers.forEach((c: any) => {
      const source = (c['Source'] || 'organic').toString().trim() || 'organic';
      if (c.id) consumerSourceById.set(c.id, source);
    });
    consumersInRange.forEach((c: any) => {
      const source = (c['Source'] || 'organic').toString().trim() || 'organic';
      bucket(source).signups++;
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
        bucket(source).saleRevenue += Number(r['Sale Amount'] || 0);
      }
    });

    // Join paid-ad spend (same date range) to each source → ROAS.
    //   roas    = BHC commission / spend  (platform return)
    //   gmvRoas = sale $ / spend          (standard marketing ROAS)
    const spend = await getSpendInRange(cutoff);
    const breakdownRows = Array.from(sourceMap.values()).map((s) => {
      const sp = spend.bySource.get(s.source.trim().toLowerCase()) || 0;
      return {
        ...s,
        spend: sp,
        roas: sp > 0 ? s.commissionDue / sp : null,
        gmvRoas: sp > 0 ? s.saleRevenue / sp : null,
      };
    });
    // Surface spend on sources that have no signups in range (pure waste) so
    // it's never hidden — otherwise blended ROAS would drop with no visible row.
    const seenSources = new Set(Array.from(sourceMap.keys()).map((k) => k.trim().toLowerCase()));
    spend.bySource.forEach((sp, src) => {
      if (!seenSources.has(src)) {
        breakdownRows.push({
          source: src, signups: 0, matches: 0, closes: 0, commissionDue: 0,
          saleRevenue: 0, spend: sp, roas: 0, gmvRoas: 0,
        });
      }
    });
    const sourceBreakdown = breakdownRows.sort((a, b) => b.commissionDue - a.commissionDue);

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
        // Deposit-funnel truth (Referrals — where tier_v2 money actually lands).
        depositsPaid: sales.depositsPaid,
        salesClosed: sales.salesClosed,
        // Legacy Inquiries 'Sale Completed' count, clearly named so the old
        // number never silently disappears.
        legacyInquirySales: sales.legacyInquirySales,
        totalSales: sales.totalSales,
        // NOTE: refRevenue/refCommission (Closed Won) are NOT added here —
        // they are already inside sales.totalRevenue/-Commission. The old
        // `+ refRevenue` double-counted every closed funnel deal.
        totalRevenue: sales.totalRevenue,
        totalCommission: sales.totalCommission,
        conversionRate: sales.conversionRate,
        totalSpend: spend.total,
        // Blended return across all paid channels. null when nothing logged.
        blendedRoas: spend.total > 0 ? sales.totalCommission / spend.total : null,
        blendedGmvRoas: spend.total > 0 ? sales.totalRevenue / spend.total : null,
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
