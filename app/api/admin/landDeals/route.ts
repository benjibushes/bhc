import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    const records = await getAllRecords(TABLES.LAND_DEALS);
    
    // Transform Airtable field names to frontend-friendly names
    const landDeals = records.map((record: any) => ({
      id: record.id,
      seller_name: record['Seller Name'] || '',
      property_location: record['Property Location'] || '',
      state: record['State'] || '',
      acreage: record['Acreage'] || 0,
      asking_price: record['Asking Price'] || '',
      status: record['Status'] || 'Pending',
      visible_to_members: record['Visible to Members'] || false,
      created_at: record['Created'] || record.createdTime || new Date().toISOString(),
    }));
    
    return NextResponse.json(landDeals);
  } catch (error: any) {
    console.error('API error fetching land deals:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
