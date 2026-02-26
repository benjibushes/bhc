import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getRecordById, getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';

export async function GET() {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('bhc-rancher-auth');

    if (!sessionCookie?.value) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(sessionCookie.value, JWT_SECRET);
    } catch {
      return NextResponse.json({ error: 'Session expired' }, { status: 401 });
    }

    if (decoded.type !== 'rancher-session') {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    const rancher = await getRecordById(TABLES.RANCHERS, decoded.rancherId) as any;
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    let allReferrals: any[] = [];
    try {
      allReferrals = await getAllRecords(TABLES.REFERRALS);
    } catch (e) {
      console.warn('Referrals table not accessible, returning empty referrals');
    }

    // Filter referrals assigned to this rancher
    const myReferrals = allReferrals.filter((r: any) => {
      const assignedIds = r['Rancher'] || [];
      const suggestedIds = r['Suggested Rancher'] || [];
      return (Array.isArray(assignedIds) && assignedIds.includes(decoded.rancherId)) ||
             (Array.isArray(suggestedIds) && suggestedIds.includes(decoded.rancherId));
    });

    const activeReferrals = myReferrals.filter((r: any) =>
      ['Intro Sent', 'Rancher Contacted', 'Negotiation'].includes(r['Status'])
    );

    const closedWon = myReferrals.filter((r: any) => r['Status'] === 'Closed Won');
    const closedLost = myReferrals.filter((r: any) => r['Status'] === 'Closed Lost');

    const totalRevenue = closedWon.reduce((sum: number, r: any) => sum + (r['Sale Amount'] || 0), 0);
    const totalCommission = closedWon.reduce((sum: number, r: any) => sum + (r['Commission Due'] || 0), 0);
    const unpaidCommission = closedWon
      .filter((r: any) => !r['Commission Paid'])
      .reduce((sum: number, r: any) => sum + (r['Commission Due'] || 0), 0);

    const referralsList = myReferrals.map((r: any) => ({
      id: r.id,
      status: r['Status'] || '',
      buyer_name: r['Buyer Name'] || '',
      buyer_email: r['Buyer Email'] || '',
      buyer_phone: r['Buyer Phone'] || '',
      buyer_state: r['Buyer State'] || '',
      order_type: r['Order Type'] || '',
      budget_range: r['Budget Range'] || '',
      notes: r['Notes'] || '',
      sale_amount: r['Sale Amount'] || 0,
      commission_due: r['Commission Due'] || 0,
      commission_paid: r['Commission Paid'] || false,
      created_at: r['Created At'] || r.createdTime || '',
      intro_sent_at: r['Intro Sent At'] || '',
      closed_at: r['Closed At'] || '',
    }));

    // Sort: active first, then by date
    referralsList.sort((a: any, b: any) => {
      const activeStatuses = ['Intro Sent', 'In Progress', 'Rancher Contacted', 'Negotiation'];
      const aActive = activeStatuses.includes(a.status) ? 0 : 1;
      const bActive = activeStatuses.includes(b.status) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    let networkBenefits: any[] = [];
    try {
      const allBrands = await getAllRecords(TABLES.BRANDS);
      networkBenefits = allBrands
        .filter((b: any) => (b['Status'] === 'approved' || b['Active'] === true))
        .map((b: any) => ({
          id: b.id,
          brand_name: b['Brand Name'] || '',
          product_type: b['Product Type'] || '',
          discount_offered: b['Discount Offered'] || 0,
          description: b['Description'] || '',
          website: b['Website'] || '',
          contact_email: b['Email'] || '',
        }));
    } catch {
      // Brands table may not be accessible
    }

    return NextResponse.json({
      rancher: {
        id: rancher.id,
        name: rancher['Operator Name'] || '',
        ranchName: rancher['Ranch Name'] || '',
        state: rancher['State'] || '',
        activeStatus: rancher['Active Status'] || 'Pending',
        onboardingStatus: rancher['Onboarding Status'] || '',
        agreementSigned: rancher['Agreement Signed'] || false,
        currentActiveReferrals: rancher['Current Active Referrals'] || 0,
        maxActiveReferrals: rancher['Max Active Referrals'] || 5,
        monthlyCapacity: rancher['Monthly Capacity'] || 0,
        beefTypes: rancher['Beef Types'] || '',
      },
      stats: {
        totalReferrals: myReferrals.length,
        activeReferrals: activeReferrals.length,
        closedWon: closedWon.length,
        closedLost: closedLost.length,
        totalRevenue,
        totalCommission,
        unpaidCommission,
        netEarnings: totalRevenue - totalCommission,
      },
      referrals: referralsList,
      networkBenefits,
    });
  } catch (error: any) {
    console.error('Rancher dashboard error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
