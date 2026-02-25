import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    const records = await getAllRecords(TABLES.CONSUMERS);
    
    const consumers = records.map((record: any) => ({
      id: record.id,
      first_name: record['Full Name'] || '',
      email: record['Email'] || '',
      phone: record['Phone'] || '',
      state: record['State'] || '',
      interests: record['Interests'] || [],
      status: record['Status'] || 'Pending',
      membership: record['Membership'] || 'none',
      order_type: record['Order Type'] || '',
      budget_range: record['Budget Range'] || '',
      notes: record['Notes'] || '',
      lead_source: record['Lead Source'] || record['Source'] || '',
      intent_score: record['Intent Score'] || 0,
      intent_classification: record['Intent Classification'] || '',
      referral_status: record['Referral Status'] || 'Unmatched',
      created_at: record['Created'] || record.createdTime || new Date().toISOString(),
    }));
    
    return NextResponse.json(consumers);
  } catch (error: any) {
    console.error('API error fetching consumers:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
