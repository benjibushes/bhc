import { NextResponse } from 'next/server';
import { getAllRecords, escapeAirtableValue } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');

    let filter = '';
    if (status) {
      filter = `{Status} = "${escapeAirtableValue(status)}"`;
    }

    let records: any[];
    try {
      records = await getAllRecords(TABLES.REFERRALS, filter || undefined);
    } catch (e) {
      console.warn('Referrals table not accessible');
      return NextResponse.json([]);
    }

    // Build rancher contact lookup so admin can email/call directly from the UI
    let rancherMap: Record<string, { email: string; phone: string; name: string }> = {};
    try {
      const ranchers = await getAllRecords(TABLES.RANCHERS) as any[];
      for (const r of ranchers) {
        rancherMap[r.id] = {
          email: r['Email'] || '',
          phone: r['Phone'] || '',
          name: r['Operator Name'] || r['Ranch Name'] || '',
        };
      }
    } catch (e) {
      console.warn('Rancher lookup failed, contact info omitted');
    }

    // Buyer lookup so admin can see warmup stage + engagement
    let buyerMap: Record<string, { warmupStage: string; warmupSentAt: string; warmupEngagedAt: string }> = {};
    try {
      const consumers = await getAllRecords(TABLES.CONSUMERS) as any[];
      for (const c of consumers) {
        buyerMap[c.id] = {
          warmupStage: c['Warmup Stage']?.name || c['Warmup Stage'] || '',
          warmupSentAt: c['Warmup Sent At'] || '',
          warmupEngagedAt: c['Warmup Engaged At'] || '',
        };
      }
    } catch (e) {
      console.warn('Consumer lookup failed, warmup info omitted');
    }

    const referrals = records.map((record: any) => {
      const rancherId = record['Rancher']?.[0] || '';
      const buyerId = record['Buyer']?.[0] || '';
      const rancherInfo = rancherMap[rancherId] || { email: '', phone: '', name: '' };
      const buyerInfo = buyerMap[buyerId] || { warmupStage: '', warmupSentAt: '', warmupEngagedAt: '' };
      return {
        id: record.id,
        buyer_id: buyerId,
        rancher_id: rancherId,
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
        rancher_email: rancherInfo.email,
        rancher_phone: rancherInfo.phone,
        notes: record['Notes'] || '',
        sale_amount: record['Sale Amount'] || 0,
        commission_due: record['Commission Due'] || 0,
        commission_paid: record['Commission Paid'] || false,
        created_at: record['Created At'] || record.createdTime || new Date().toISOString(),
        approved_at: record['Approved At'] || '',
        intro_sent_at: record['Intro Sent At'] || '',
        closed_at: record['Closed At'] || '',
        chase_count: record['Chase Count'] || 0,
        last_chased_at: record['Last Chased At'] || '',
        rancher_reminded_at: record['Rancher Reminded At'] || '',
        warmup_stage: buyerInfo.warmupStage,
        warmup_sent_at: buyerInfo.warmupSentAt,
        warmup_engaged_at: buyerInfo.warmupEngagedAt,
      };
    });

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
