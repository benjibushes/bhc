// WAVE 3a (2026-06-30): rancher CRM data route.
//
// Returns the logged-in rancher's buyers (past + present) grouped from their
// OWN referrals — name, contact, total deals, lifetime $ (sum of Closed Won
// Sale Amounts), last deal date, repeat-buyer flag, and the referral ids to
// jump to. A D2C beef business lives on repeat buyers; this is the missing CRM.
//
// Read-only. No money/settlement logic. Scoping is IDENTICAL to
// /api/rancher/dashboard — load all referrals, filter to ones where THIS
// rancher is linked (Rancher or Suggested Rancher). The grouping is the pure
// helper in lib/rancherCrm.ts (unit-tested in lib/rancherCrm.test.ts).

import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { requireRancher } from '@/lib/rancherAuth';
import { groupReferralsByBuyer, type CrmReferral } from '@/lib/rancherCrm';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: Request) {
  try {
    const r = await requireRancher(request);
    if (r instanceof NextResponse) return r;
    const { session } = r;

    // Same scoping rationale as dashboard/route.ts: Airtable ARRAYJOIN on a
    // linked-record field renders the linked record's PRIMARY FIELD, not its
    // id, so a filterByFormula on {Rancher} can't match by id. Load + filter
    // client-side, restricting strictly to this rancher's referrals.
    let myReferrals: any[] = [];
    try {
      const allRefs = (await getAllRecords(TABLES.REFERRALS)) as any[];
      const myId = session.rancherId;
      myReferrals = allRefs.filter((row: any) => {
        const rancher = Array.isArray(row['Rancher']) ? row['Rancher'] : [];
        const suggested = Array.isArray(row['Suggested Rancher']) ? row['Suggested Rancher'] : [];
        return rancher.includes(myId) || suggested.includes(myId);
      });
    } catch {
      console.warn('[rancher customers] Referrals table not accessible, returning empty');
    }

    const crmRefs: CrmReferral[] = myReferrals.map((row: any) => ({
      id: row.id,
      status: String(row['Status'] || ''),
      buyer_name: row['Buyer Name'] || '',
      buyer_email: row['Buyer Email'] || '',
      buyer_phone: row['Buyer Phone'] || '',
      buyer_state: row['Buyer State'] || '',
      order_type: row['Order Type'] || '',
      sale_amount: Number(row['Sale Amount'] || 0),
      created_at: row['Created At'] || row._createdTime || '',
      intro_sent_at: row['Intro Sent At'] || '',
      closed_at: row['Closed At'] || '',
    }));

    const customers = groupReferralsByBuyer(crmRefs);

    return NextResponse.json({
      customers,
      totalCustomers: customers.length,
      repeatCustomers: customers.filter((c) => c.isRepeat).length,
    });
  } catch (error: any) {
    console.error('Rancher customers error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
