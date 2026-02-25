import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    const [consumers, ranchers, referrals] = await Promise.all([
      getAllRecords(TABLES.CONSUMERS),
      getAllRecords(TABLES.RANCHERS),
      getAllRecords(TABLES.REFERRALS),
    ]);

    const pendingApproval = referrals.filter((r: any) => r['Status'] === 'Pending Approval').length;

    const buyersByState: Record<string, number> = {};
    consumers.forEach((c: any) => {
      const state = c['State'] || 'Unknown';
      buyersByState[state] = (buyersByState[state] || 0) + 1;
    });
    const buyersByStateArr = Object.entries(buyersByState)
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const activeReferralsByRancher = ranchers
      .filter((r: any) => (r['Current Active Referrals'] || 0) > 0)
      .map((r: any) => ({
        rancherId: r.id,
        name: r['Operator Name'] || r['Ranch Name'] || 'Unknown',
        state: r['State'] || '',
        count: r['Current Active Referrals'] || 0,
        max: r['Max Active Referrals'] || 5,
      }))
      .sort((a: any, b: any) => b.count - a.count);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const closedThisMonth = referrals.filter((r: any) => {
      if (r['Status'] !== 'Closed Won') return false;
      const closedAt = r['Closed At'];
      return closedAt && closedAt >= startOfMonth;
    });

    const totalCommission = closedThisMonth.reduce(
      (sum: number, r: any) => sum + (r['Commission Due'] || 0), 0
    );

    const statusCounts: Record<string, number> = {};
    referrals.forEach((r: any) => {
      const s = r['Status'] || 'Unknown';
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    });

    return NextResponse.json({
      totalBuyers: consumers.length,
      totalRanchers: ranchers.length,
      totalReferrals: referrals.length,
      pendingApproval,
      buyersByState: buyersByStateArr,
      activeReferralsByRancher,
      closedDealsThisMonth: {
        count: closedThisMonth.length,
        totalCommission: Math.round(totalCommission * 100) / 100,
      },
      statusCounts,
    });
  } catch (error: any) {
    console.error('Error fetching referral stats:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
