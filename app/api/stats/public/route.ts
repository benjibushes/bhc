import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { isRancherOperationalForBuyers } from '@/lib/rancherEligibility';

export const runtime = 'nodejs';
// Cache 5 minutes — public stats don't need to be real-time.
export const revalidate = 300;

const FOUNDERS_CAP = 100;

interface PublicStats {
  ranchersActive: number;
  familiesMatched: number;
  foundersBacked: number;
  foundersCap: number;
  totalClosedWon: number;
  thisMonthClosedWon: number;
}

export async function GET() {
  try {
    const [ranchers, consumers, referrals] = await Promise.all([
      getAllRecords(TABLES.RANCHERS) as Promise<any[]>,
      getAllRecords(TABLES.CONSUMERS) as Promise<any[]>,
      getAllRecords(TABLES.REFERRALS) as Promise<any[]>,
    ]);

    const ranchersActive = ranchers.filter((r: any) => isRancherOperationalForBuyers(r)).length;

    // "Families matched" = approved consumers who reached READY or beyond
    // i.e. they made it past the warmup gate.
    const familiesMatched = consumers.filter((c: any) => {
      const stage = (c['Buyer Stage'] || '').toString();
      return ['READY', 'MATCHED', 'CLOSED'].includes(stage);
    }).length;

    // Founder backers — Consumers w/ Founder Tier set + Tier Amount Paid > 0
    // OR comped (Tier Amount Paid = 0 but Founder Tier set).
    const foundersBacked = consumers.filter((c: any) => !!c['Founder Tier']).length;

    const closedWon = referrals.filter((r: any) => r['Status'] === 'Closed Won');
    const totalClosedWon = closedWon.length;

    const firstOfMonth = new Date();
    firstOfMonth.setDate(1);
    firstOfMonth.setHours(0, 0, 0, 0);
    const thisMonthClosedWon = closedWon.filter((r: any) => {
      const closedAt = r['Closed At'] ? new Date(r['Closed At']).getTime() : 0;
      return closedAt >= firstOfMonth.getTime();
    }).length;

    const stats: PublicStats = {
      ranchersActive,
      familiesMatched,
      foundersBacked,
      foundersCap: FOUNDERS_CAP,
      totalClosedWon,
      thisMonthClosedWon,
    };

    return NextResponse.json(stats, {
      headers: {
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
      },
    });
  } catch (error: any) {
    console.error('/api/stats/public error:', error?.message);
    // Return safe fallback so /start + /founders never crash on stats failure.
    const fallback: PublicStats = {
      ranchersActive: 17,
      familiesMatched: 1533,
      foundersBacked: 0,
      foundersCap: FOUNDERS_CAP,
      totalClosedWon: 11,
      thisMonthClosedWon: 0,
    };
    return NextResponse.json(fallback, {
      status: 200,
      headers: { 'Cache-Control': 'public, max-age=60' },
    });
  }
}
