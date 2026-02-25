import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';

export async function GET() {
  try {
    // Verify member session
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('bhc-member-auth');

    let memberState = '';
    let memberId = '';

    if (sessionCookie?.value) {
      try {
        const decoded: any = jwt.verify(sessionCookie.value, JWT_SECRET);
        if (decoded.type === 'member-session') {
          memberState = decoded.state || '';
          memberId = decoded.consumerId || '';
        }
      } catch {
        return NextResponse.json({ error: 'Session expired' }, { status: 401 });
      }
    } else {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const [ranchers, landDeals, brands] = await Promise.all([
      getAllRecords(TABLES.RANCHERS, "{Certified} = TRUE()").catch(() => []),
      getAllRecords(TABLES.LAND_DEALS, "{Status} = 'Approved'").catch(() => []),
      getAllRecords(TABLES.BRANDS, "{Featured} = TRUE()").catch(() => []),
    ]);

    let referrals: any[] = [];
    try {
      referrals = await getAllRecords(TABLES.REFERRALS);
    } catch (e) {
      console.warn('Referrals table not accessible, returning empty referrals');
    }

    // Filter ranchers by member's state (show state matches first, then all)
    const stateRanchers = ranchers.filter((r: any) => {
      const rState = r['State'] || '';
      const statesServed = r['States Served'] || '';
      return rState === memberState ||
        (typeof statesServed === 'string' && statesServed.split(',').map((s: string) => s.trim()).includes(memberState));
    });
    const otherRanchers = ranchers.filter((r: any) => !stateRanchers.some((sr: any) => sr.id === r.id));

    // Get member's referral status
    const memberReferrals = referrals.filter((r: any) => {
      const buyerIds = r['Buyer'] || [];
      return Array.isArray(buyerIds) ? buyerIds.includes(memberId) : buyerIds === memberId;
    }).map((r: any) => ({
      id: r.id,
      status: r['Status'] || '',
      rancher_name: r['Suggested Rancher Name'] || '',
      created_at: r['Created At'] || '',
    }));

    return NextResponse.json({
      memberState,
      stateRanchers,
      otherRanchers,
      landDeals,
      brands,
      memberReferrals,
    });
  } catch (error: any) {
    console.error('API error fetching member content:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
