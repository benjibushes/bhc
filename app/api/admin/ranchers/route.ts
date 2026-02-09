import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    const records = await getAllRecords(TABLES.RANCHERS);
    
    // Transform Airtable field names to frontend-friendly names
    const ranchers = records.map((record: any) => ({
      id: record.id,
      ranch_name: record['Ranch Name'] || '',
      operator_name: record['Operator Name'] || '',
      email: record['Email'] || '',
      phone: record['Phone'] || '',
      state: record['State'] || '',
      beef_types: record['Beef Types'] || '',
      status: record['Status'] || 'Pending',
      certified: record['Certified'] || false,
      ranch_tour_interested: record['Ranch Tour Interested'] || false,
      ranch_tour_availability: record['Ranch Tour Availability'] || '',
      call_scheduled: record['Call Scheduled'] || false,
      created_at: record['Created'] || record.createdTime || new Date().toISOString(),
    }));
    
    return NextResponse.json(ranchers);
  } catch (error: any) {
    console.error('API error fetching ranchers:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
