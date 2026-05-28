import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { normalizeState, normalizeStates } from '@/lib/states';
import { resolveBuyerSession } from '@/lib/buyerAuth';

export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const session = await resolveBuyerSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    let memberState = session.state || '';
    const memberId = session.consumerId;
    let memberSegment = '';
    let memberOrderType = '';

    // Fetch member's segment from their consumer record. Also rehydrate
    // memberState if JWT didn't carry it — older session tokens minted by
    // /api/warmup/engage didn't include state, which made the dashboard
    // show "0 ranchers" even after a successful match. Defense-in-depth
    // so any future token shape change can't strand the buyer.
    if (memberId) {
      try {
        const { getRecordById } = await import('@/lib/airtable');
        const consumer: any = await getRecordById(TABLES.CONSUMERS, memberId);
        memberSegment = consumer['Segment'] || '';
        memberOrderType = consumer['Order Type'] || '';
        if (!memberState && consumer['State']) memberState = String(consumer['State']);
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
    //
    // Resolve rancher name LIVE from the linked record (not the stale
    // "Suggested Rancher Name" text cache). Same drift bug class that
    // produced "Jose at High Lonesome" in chase-up emails — when ranchers
    // get renamed or replaced, the cache lags.
    const ranchersById = new Map<string, any>();
    for (const r of ranchers) ranchersById.set((r as any).id, r);
    const memberReferrals = referrals.filter((r: any) => {
      const buyerIds = r['Buyer'] || [];
      return Array.isArray(buyerIds) ? buyerIds.includes(memberId) : buyerIds === memberId;
    }).map((r: any) => {
      const rancherLinks = r['Rancher'] || r['Suggested Rancher'] || [];
      const rancherId = Array.isArray(rancherLinks) ? rancherLinks[0] : null;
      let rancherName = r['Suggested Rancher Name'] || '';
      let rancherEmail = '';
      let rancherPhone = '';
      let rancherSlug = '';
      if (rancherId && ranchersById.has(rancherId)) {
        const rr: any = ranchersById.get(rancherId);
        rancherName = rr['Operator Name'] || rr['Ranch Name'] || rancherName;
        rancherEmail = rr['Email'] || '';
        rancherPhone = rr['Phone'] || '';
        rancherSlug = rr['Slug'] || '';
      }
      return {
        id: r.id,
        status: r['Status'] || '',
        rancher_id: rancherId,
        rancher_name: rancherName,
        rancher_email: rancherEmail,
        rancher_phone: rancherPhone,
        rancher_slug: rancherSlug,
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
