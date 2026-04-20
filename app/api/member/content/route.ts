import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { normalizeState, normalizeStates } from '@/lib/states';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';

export const maxDuration = 60;

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';

export async function GET() {
  try {
    // Verify member session
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('bhc-member-auth');

    let memberState = '';
    let memberId = '';
    let memberSegment = '';
    let memberOrderType = '';

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

    // Fetch member's segment from their consumer record
    if (memberId) {
      try {
        const { getRecordById } = await import('@/lib/airtable');
        const consumer: any = await getRecordById(TABLES.CONSUMERS, memberId);
        memberSegment = consumer['Segment'] || '';
        memberOrderType = consumer['Order Type'] || '';
      } catch {
        // Non-fatal, segment will be empty
      }
    }

    const [ranchers, landDeals, brands] = await Promise.all([
      getAllRecords(TABLES.RANCHERS, "{Certified} = TRUE()").catch(() => []),
      getAllRecords(TABLES.LAND_DEALS, "{Status} = 'Approved'").catch(() => []),
      // NOTE: Brands schema has no "Payment Status" field — the old filter
      // was always returning [] silently. Featured/Status are multilineText,
      // so use truthy-string checks. Brands are curated before being added.
      getAllRecords(TABLES.BRANDS, "{Featured}").catch(() => []),
    ]);

    let referrals: any[] = [];
    try {
      referrals = await getAllRecords(TABLES.REFERRALS);
    } catch (e) {
      console.warn('Referrals table not accessible, returning empty referrals');
    }

    // Filter ranchers by member's state. Use normalizeState so "Montana" and
    // "MT" are both recognized (this comparison was buggy before — same root
    // cause as the matching engine state bug).
    const memberStateCode = normalizeState(memberState);
    const stateRanchers = ranchers.filter((r: any) => {
      const rState = normalizeState(r['State']);
      const served = normalizeStates(r['States Served']);
      return rState === memberStateCode || served.includes(memberStateCode);
    });
    const otherRanchers = ranchers.filter((r: any) => !stateRanchers.some((sr: any) => sr.id === r.id));

    // Get member's referral status — include rancher_id, sale_amount, and
    // closed_at so the UI can render the "Your Match" hero AND a "Past Orders
    // → Reorder" section for repeat customers.
    const memberReferrals = referrals.filter((r: any) => {
      const buyerIds = r['Buyer'] || [];
      return Array.isArray(buyerIds) ? buyerIds.includes(memberId) : buyerIds === memberId;
    }).map((r: any) => {
      const rancherLinks = r['Rancher'] || r['Suggested Rancher'] || [];
      const rancherId = Array.isArray(rancherLinks) ? rancherLinks[0] : null;
      return {
        id: r.id,
        status: r['Status'] || '',
        rancher_id: rancherId,
        rancher_name: r['Suggested Rancher Name'] || '',
        order_type: r['Order Type'] || '',
        sale_amount: r['Sale Amount'] || 0,
        closed_at: r['Closed At'] || '',
        created_at: r['Created At'] || '',
      };
    });

    return NextResponse.json({
      memberState,
      memberSegment,
      hasOrderDetails: !!memberOrderType,
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
