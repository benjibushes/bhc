import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { requireRole } from '@/lib/adminAuth';
import { getMaxActiveReferrals } from '@/lib/rancherCapacity';

export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    // Opened to 'onboarding' partner: read-only rancher list for kanban/migration.
    const __authResp = await requireRole(request, ['admin', 'onboarding']);
    if (__authResp) return __authResp;
    const records = await getAllRecords(TABLES.RANCHERS);
    
    // Transform Airtable field names to frontend-friendly names
    const ranchers = records.map((record: any) => {
      // Deposit-collection readiness — can this rancher actually collect a deposit
      // through the Stripe Connect rail RIGHT NOW? Surfaces flip-and-collect-ready
      // vs blocked (legacy = off-platform; Connect not active; price typo; paused).
      const _pricingModel = String(record['Pricing Model'] || 'legacy').toLowerCase();
      const _connectStatus = String(record['Stripe Connect Status'] || '').toLowerCase();
      const _connectAcct = record['Stripe Account Id'] || record['Stripe Connect Account Id'] || '';
      const _activeStatus = String(record['Active Status'] || '');
      const _maxPrice = Math.max(
        0,
        Number(record['Quarter Price']) || 0,
        Number(record['Half Price']) || 0,
        Number(record['Whole Price']) || 0,
      );
      const _collectBlockers: string[] = [];
      if (_pricingModel !== 'tier_v2') {
        _collectBlockers.push('legacy — collects off-platform via Payment Links, not the deposit rail');
      } else {
        if (_connectStatus !== 'active') _collectBlockers.push('Stripe Connect not active');
        if (!_connectAcct) _collectBlockers.push('no Connect account id');
        if (_maxPrice < 100) {
          _collectBlockers.push(_maxPrice > 0 ? `price too low ($${_maxPrice} — likely a per-lb typo)` : 'no cut price set');
        }
        if (_activeStatus !== 'Active') _collectBlockers.push(`Active Status = ${_activeStatus || 'empty'}`);
      }
      const _collectReady = _pricingModel === 'tier_v2' && _collectBlockers.length === 0;
      return {
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
      max_active_referrals: getMaxActiveReferrals(record),
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
      custom_products: record['Custom Products'] || '',
      google_reviews_url: record['Google Reviews URL'] || '',
      facebook_url: record['Facebook URL'] || '',
      instagram_url: record['Instagram URL'] || '',
      processing_facility: record['Processing Facility'] || '',
      verification_method: record['Verification Method'] || '',
      verification_notes: record['Verification Notes'] || '',
      ships_nationwide: record['Ships Nationwide'] || false,
      // Multi-state routing (the "serve these states" flip). Routing States only
      // takes effect when Admin Approved Multi-State is true. State Capacity
      // Override is the per-state slot map that prevents the sub-cap flooring to 0.
      routing_states: record['Routing States'] || '',
      admin_approved_multi_state: record['Admin Approved Multi-State'] || false,
      state_capacity_override: record['State Capacity Override'] || '',
      // Pricing Model + tier + Stripe Connect status — surfaced so admin UI
      // can show v2 upgrade button for legacy ranchers + adoption funnel.
      pricing_model: record['Pricing Model'] || 'legacy',
      tier: (() => {
        const t = record['Tier'];
        if (!t) return '';
        if (typeof t === 'object' && 'name' in t) return String(t.name || '');
        return String(t);
      })(),
      subscription_status: record['Subscription Status'] || '',
      stripe_connect_account_id: record['Stripe Account Id'] || record['Stripe Connect Account Id'] || '',
      v2_upgrade_invite_sent_at: record['V2 Upgrade Invite Sent At'] || '',
      quarter_deposit: record['Quarter Deposit'] || null,
      half_deposit: record['Half Deposit'] || null,
      whole_deposit: record['Whole Deposit'] || null,
      quarter_clicks: record['Quarter Clicks'] || 0,
      half_clicks: record['Half Clicks'] || 0,
      whole_clicks: record['Whole Clicks'] || 0,
      created_at: record['Created'] || record.createdTime || record._createdTime || new Date().toISOString(),
      collect_ready: _collectReady,
      collect_blockers: _collectBlockers,
      };
    });

    return NextResponse.json(ranchers);
  } catch (error: any) {
    console.error('API error fetching ranchers:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
