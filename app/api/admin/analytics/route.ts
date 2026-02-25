import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    const consumers = await getAllRecords(TABLES.CONSUMERS);
    const inquiries = await getAllRecords(TABLES.INQUIRIES);
    const campaigns = await getAllRecords(TABLES.CAMPAIGNS);

    let referrals: any[] = [];
    try {
      referrals = await getAllRecords(TABLES.REFERRALS);
    } catch {
      // Referrals table may not exist yet
    }

    const completedSales = inquiries.filter((i: any) => i['Status'] === 'Sale Completed');
    const totalSales = completedSales.length;
    const totalRevenue = completedSales.reduce((sum: number, i: any) => {
      return sum + (parseFloat(i['Sale Amount'] || '0'));
    }, 0);
    const totalCommission = completedSales.reduce((sum: number, i: any) => {
      return sum + (parseFloat(i['Commission Amount'] || '0'));
    }, 0);
    const conversionRate = inquiries.length > 0 ? totalSales / inquiries.length : 0;

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

    consumers.forEach((c: any) => {
      const campaign = c['Campaign'];
      if (campaign && campaignMap.has(campaign)) {
        const stats = campaignMap.get(campaign);
        stats.signUps++;
      }
    });

    inquiries.forEach((i: any) => {
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

    const recentActivity: any[] = [];

    consumers
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

    inquiries
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

    // Referral analytics
    const closedWon = referrals.filter((r: any) => r['Status'] === 'Closed Won');
    const refRevenue = closedWon.reduce((s: number, r: any) => s + (r['Sale Amount'] || 0), 0);
    const refCommission = closedWon.reduce((s: number, r: any) => s + (r['Commission Due'] || 0), 0);
    const pendingReferrals = referrals.filter((r: any) => r['Status'] === 'Pending Approval').length;
    const activeReferrals = referrals.filter((r: any) =>
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
    const highIntentTotal = referrals.filter((r: any) => r['Intent Classification'] === 'High').length;
    const medIntentClosed = closedWon.filter((r: any) => r['Intent Classification'] === 'Medium').length;
    const medIntentTotal = referrals.filter((r: any) => r['Intent Classification'] === 'Medium').length;

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
      overview: {
        totalConsumers: consumers.length,
        totalInquiries: inquiries.length,
        totalSales,
        totalRevenue: totalRevenue + refRevenue,
        totalCommission: totalCommission + refCommission,
        conversionRate,
      },
      referralStats: {
        total: referrals.length,
        pending: pendingReferrals,
        active: activeReferrals,
        closedWon: closedWon.length,
        closedLost: referrals.filter((r: any) => r['Status'] === 'Closed Lost').length,
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
      recentActivity: recentActivity.slice(0, 20),
    });
  } catch (error: any) {
    console.error('Error fetching analytics:', error);
    return NextResponse.json({ error: error.message || 'Failed to fetch analytics' }, { status: 500 });
  }
}


