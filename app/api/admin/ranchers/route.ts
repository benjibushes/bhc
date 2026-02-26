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
      states_served: record['States Served'] || '',
      agreement_signed: record['Agreement Signed'] || false,
      active_status: record['Active Status'] || 'Pending Onboarding',
      monthly_capacity: record['Monthly Capacity'] || 0,
      max_active_referrals: record['Max Active Referrals'] || 5,
      current_active_referrals: record['Current Active Referrals'] || 0,
      last_assigned_at: record['Last Assigned At'] || '',
      performance_score: record['Performance Score'] || 50,
      onboarding_complete: record['Onboarding Complete'] || false,
      onboarding_status: record['Onboarding Status'] || '',
      call_notes: record['Call Notes'] || '',
      call_completed_at: record['Call Completed At'] || '',
      docs_sent_at: record['Docs Sent At'] || '',
      agreement_signed_at: record['Agreement Signed At'] || '',
      verification_status: record['Verification Status'] || 'Not Started',
      featured: record['Featured'] || false,
      release_date: record['Release Date'] || '',
      created_at: record['Created'] || record.createdTime || new Date().toISOString(),
    }));
    
    return NextResponse.json(ranchers);
  } catch (error: any) {
    console.error('API error fetching ranchers:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
