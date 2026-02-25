import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');

    let filter = '';
    if (status) {
      filter = `{Status} = "${status}"`;
    }

    const records = await getAllRecords(TABLES.REFERRALS, filter || undefined);

    const referrals = records.map((record: any) => ({
      id: record.id,
      buyer_id: record['Buyer']?.[0] || '',
      rancher_id: record['Rancher']?.[0] || '',
      suggested_rancher_id: record['Suggested Rancher']?.[0] || '',
      status: record['Status'] || 'Pending Approval',
      buyer_name: record['Buyer Name'] || '',
      buyer_email: record['Buyer Email'] || '',
      buyer_phone: record['Buyer Phone'] || '',
      buyer_state: record['Buyer State'] || '',
      order_type: record['Order Type'] || '',
      budget_range: record['Budget Range'] || '',
      intent_score: record['Intent Score'] || 0,
      intent_classification: record['Intent Classification'] || '',
      suggested_rancher_name: record['Suggested Rancher Name'] || '',
      suggested_rancher_state: record['Suggested Rancher State'] || '',
      notes: record['Notes'] || '',
      sale_amount: record['Sale Amount'] || 0,
      commission_due: record['Commission Due'] || 0,
      commission_paid: record['Commission Paid'] || false,
      created_at: record['Created At'] || record.createdTime || new Date().toISOString(),
      approved_at: record['Approved At'] || '',
      intro_sent_at: record['Intro Sent At'] || '',
      closed_at: record['Closed At'] || '',
    }));

    referrals.sort((a: any, b: any) => {
      if (a.status === 'Pending Approval' && b.status !== 'Pending Approval') return -1;
      if (a.status !== 'Pending Approval' && b.status === 'Pending Approval') return 1;
      return b.intent_score - a.intent_score;
    });

    return NextResponse.json(referrals);
  } catch (error: any) {
    console.error('Error fetching referrals:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
