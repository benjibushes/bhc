import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, TABLES } from '@/lib/airtable';
import { isRancherOperationalForBuyers } from '@/lib/rancherEligibility';

export const runtime = 'nodejs';
// Cache 5 minutes — public stats don't need to be real-time. ISR
// + edge cache means most requests hit cache, not Airtable.
export const revalidate = 300;

const FOUNDERS_CAP = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

interface LatestClose {
  firstName: string;
  orderType: string;
  ranchName: string;
  ranchSlug: string;
  buyerState: string;
  daysAgo: number;
}

interface Activity24h {
  closes: number;
  matched: number;
  signups: number;
}

interface PublicStats {
  ranchersActive: number;
  familiesMatched: number;
  foundersBacked: number;
  foundersCap: number;
  totalClosedWon: number;
  thisMonthClosedWon: number;
  // Extended fields — power /start LIVE badge + 24h activity strip
  // without /start needing to make additional Airtable calls. Single
  // cached endpoint feeds the landing page.
  latestClose: LatestClose | null;
  activity24h: Activity24h;
}

export async function GET() {
  try {
    const [ranchers, consumers, referrals] = await Promise.all([
      getAllRecords(TABLES.RANCHERS) as Promise<any[]>,
      getAllRecords(TABLES.CONSUMERS) as Promise<any[]>,
      getAllRecords(TABLES.REFERRALS) as Promise<any[]>,
    ]);

    const ranchersActive = ranchers.filter((r: any) => isRancherOperationalForBuyers(r)).length;

    // "Families in pipeline" = anyone past raw lead status.
    // Includes NEW (just signed up) + WAITING (no rancher in state yet) +
    // READY (rancher exists, hasn't engaged) + MATCHED (intro fired) +
    // CLOSED (purchased or ghosted). Excludes nothing — fresh signups
    // should show in the public counter so /start + /access reflect real
    // pipeline depth, not just downstream-cron-promoted records.
    const familiesMatched = consumers.filter((c: any) => {
      const stage = (c['Buyer Stage'] || '').toString();
      const status = (c['Status'] || '').toString();
      // Stage-based count if Buyer Stage set
      if (stage) {
        return ['NEW', 'WAITING', 'READY', 'MATCHED', 'CLOSED'].includes(stage);
      }
      // Fallback for legacy records w/o Buyer Stage: count Approved
      return status === 'Approved';
    }).length;

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

    // ── 24h activity counters ────────────────────────────────────────
    const since = Date.now() - DAY_MS;
    const closes24h = closedWon.filter((r: any) => {
      const t = r['Closed At'] ? new Date(r['Closed At']).getTime() : 0;
      return t >= since;
    }).length;
    const matched24h = referrals.filter((r: any) => {
      const t = r['Intro Sent At'] ? new Date(r['Intro Sent At']).getTime() : 0;
      return t >= since;
    }).length;
    const signups24h = consumers.filter((c: any) => {
      const t = c['Created'] || c['Created At'] || '';
      const ts = t ? new Date(t.toString()).getTime() : 0;
      return ts >= since;
    }).length;

    // ── Latest Closed Won referral (hydrated w/ rancher) ─────────────
    let latestClose: LatestClose | null = null;
    if (closedWon.length > 0) {
      const sorted = [...closedWon]
        .filter((r: any) => Number(r['Sale Amount']) > 0)
        .sort((a: any, b: any) => {
          const aT = new Date((a['Closed At'] || '').toString()).getTime() || 0;
          const bT = new Date((b['Closed At'] || '').toString()).getTime() || 0;
          return bT - aT;
        });
      if (sorted.length > 0) {
        const ref = sorted[0];
        const buyerName = (ref['Buyer Name'] || '').toString();
        const firstName = buyerName.trim().split(/\s+/)[0] || 'a buyer';
        const orderType = (ref['Order Type'] || 'Beef').toString();
        const buyerState = (ref['Buyer State'] || '').toString();
        const closedAt = (ref['Closed At'] || '').toString();
        const daysAgo = closedAt
          ? Math.max(0, Math.floor((Date.now() - new Date(closedAt).getTime()) / DAY_MS))
          : 0;
        let ranchName = 'a verified rancher';
        let ranchSlug = '';
        const rancherIds: string[] = (ref['Rancher'] || []) as string[];
        if (rancherIds[0]) {
          try {
            const rancher: any = await getRecordById(TABLES.RANCHERS, rancherIds[0]);
            ranchName = (rancher['Ranch Name'] || rancher['Operator Name'] || ranchName).toString();
            ranchSlug = (rancher['Slug'] || '').toString();
          } catch {
            // fall through w/ generic ranchName
          }
        }
        latestClose = { firstName, orderType, ranchName, ranchSlug, buyerState, daysAgo };
      }
    }

    const stats: PublicStats = {
      ranchersActive,
      familiesMatched,
      foundersBacked,
      foundersCap: FOUNDERS_CAP,
      totalClosedWon,
      thisMonthClosedWon,
      latestClose,
      activity24h: { closes: closes24h, matched: matched24h, signups: signups24h },
    };

    return NextResponse.json(stats, {
      headers: {
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
      },
    });
  } catch (error: any) {
    console.error('/api/stats/public error:', error?.message);
    const fallback: PublicStats = {
      ranchersActive: 17,
      familiesMatched: 1533,
      foundersBacked: 0,
      foundersCap: FOUNDERS_CAP,
      totalClosedWon: 11,
      thisMonthClosedWon: 0,
      latestClose: null,
      activity24h: { closes: 0, matched: 0, signups: 0 },
    };
    return NextResponse.json(fallback, {
      status: 200,
      headers: { 'Cache-Control': 'public, max-age=60' },
    });
  }
}
