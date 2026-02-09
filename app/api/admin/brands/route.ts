import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    const records = await getAllRecords(TABLES.BRANDS);
    
    // Transform Airtable field names to frontend-friendly names
    const brands = records.map((record: any) => ({
      id: record.id,
      brand_name: record['Brand Name'] || '',
      contact_name: record['Contact Name'] || '',
      email: record['Email'] || '',
      product_type: record['Product Type'] || '',
      discount_offered: record['Discount Offered (%)'] || 0,
      status: record['Status'] || 'Pending',
      active: record['Active'] || false,
      created_at: record['Created'] || record.createdTime || new Date().toISOString(),
    }));
    
    return NextResponse.json(brands);
  } catch (error: any) {
    console.error('API error fetching brands:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
