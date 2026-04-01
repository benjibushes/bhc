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
      max_active_referrals: record['Max Active Referalls'] || 5,
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
      referred_by: record['Referred By'] || '',
      slug: record['Slug'] || '',
      page_live: record['Page Live'] || false,
      // Landing page fields
      tagline: record['Tagline'] || '',
      about_text: record['About Text'] || '',
      logo_url: record['Logo URL'] || '',
      video_url: record['Video URL'] || '',
      custom_notes: record['Custom Notes'] || '',
      quarter_price: record['Quarter Price'] || null,
      quarter_lbs: record['Quarter lbs'] || '',
      quarter_payment_link: record['Quarter Payment Link'] || '',
      half_price: record['Half Price'] || null,
      half_lbs: record['Half lbs'] || '',
      half_payment_link: record['Half Payment Link'] || '',
      whole_price: record['Whole Price'] || null,
      whole_lbs: record['Whole lbs'] || '',
      whole_payment_link: record['Whole Payment Link'] || '',
      next_processing_date: record['Next Processing Date'] || '',
      reserve_link: record['Reserve Link'] || '',
      testimonials: record['Testimonials'] || '',
      gallery_photos: record['Gallery Photos'] || '',
      google_reviews_url: record['Google Reviews URL'] || '',
      facebook_url: record['Facebook URL'] || '',
      instagram_url: record['Instagram URL'] || '',
      processing_facility: record['Processing Facility'] || '',
      verification_method: record['Verification Method'] || '',
      verification_notes: record['Verification Notes'] || '',
      ships_nationwide: record['Ships Nationwide'] || false,
      quarter_clicks: record['Quarter Clicks'] || 0,
      half_clicks: record['Half Clicks'] || 0,
      whole_clicks: record['Whole Clicks'] || 0,
      created_at: record['Created'] || record.createdTime || new Date().toISOString(),
    }));
    
    return NextResponse.json(ranchers);
  } catch (error: any) {
    console.error('API error fetching ranchers:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
