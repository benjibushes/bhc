import { NextResponse, NextRequest } from 'next/server';
import { getRecordById, updateRecord, deleteRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendRancherApproval, sendRancherGoLiveEmail } from '@/lib/email';
import { requireAdmin } from '@/lib/adminAuth';
import { getMaxActiveReferrals, MAX_ACTIVE_REFERRALS_FIELD } from '@/lib/rancherCapacity';
import { triggerLaunchWarmup } from '@/lib/triggerLaunchWarmup';
import { logAuditEntry, buildAirtableUpdateReverse } from '@/lib/auditLog';
import { geocodeRancher } from '@/lib/geocode';

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;
    const { id } = await context.params;
    const body = await request.json();

    // Build update fields object
    const fields: any = {};
    if (body.status) fields['Status'] = body.status;
    // For Airtable checkboxes: true to check, false to uncheck
    if (body.certified === true) fields['Certified'] = true;
    else if (body.certified === false) fields['Certified'] = false;
    if (body.call_scheduled === true) fields['Call Scheduled'] = true;
    else if (body.call_scheduled === false) fields['Call Scheduled'] = false;
    if (body.ranchName) fields['Ranch Name'] = body.ranchName;
    if (body.operatorName) fields['Operator Name'] = body.operatorName;
    if (body.email) fields['Email'] = body.email;
    if (body.phone !== undefined) fields['Phone'] = body.phone;
    if (body.state) fields['State'] = body.state;
    if (body.zip !== undefined) fields['Zip'] = body.zip;
    if (body.city !== undefined) fields['City'] = body.city;
    if (body.beefTypes) fields['Beef Types'] = body.beefTypes;
    if (body.monthlyCapacity !== undefined) fields['Monthly Capacity'] = parseInt(body.monthlyCapacity);
    if (body.certifications !== undefined) fields['Certifications'] = body.certifications;
    if (body.onboarding_status) fields['Onboarding Status'] = body.onboarding_status;
    if (body.active_status) fields['Active Status'] = body.active_status;
    if (body.agreement_signed === true) fields['Agreement Signed'] = true;
    else if (body.agreement_signed === false) fields['Agreement Signed'] = false;
    if (body.states_served) fields['States Served'] = body.states_served;
    if (body.max_active_referrals !== undefined) fields[MAX_ACTIVE_REFERRALS_FIELD] = parseInt(body.max_active_referrals);
    if (body.performance_score !== undefined) fields['Performance Score'] = parseInt(body.performance_score);
    if (body.verification_status) fields['Verification Status'] = body.verification_status;
    if (body.call_notes) fields['Call Notes'] = body.call_notes;
    if (body.featured === true) fields['Featured'] = true;
    else if (body.featured === false) fields['Featured'] = false;
    if (body.release_date !== undefined) fields['Release Date'] = body.release_date || null;
    // ── Landing page fields (for admin page editor) ──
    if (body.slug !== undefined) fields['Slug'] = body.slug;
    if (body.tagline !== undefined) fields['Tagline'] = body.tagline;
    if (body.about_text !== undefined) fields['About Text'] = body.about_text;
    if (body.logo_url !== undefined) fields['Logo URL'] = body.logo_url;
    if (body.video_url !== undefined) fields['Video URL'] = body.video_url;
    if (body.custom_notes !== undefined) fields['Custom Notes'] = body.custom_notes;
    if (body.quarter_price !== undefined) fields['Quarter Price'] = body.quarter_price ? parseFloat(body.quarter_price) : null;
    if (body.quarter_lbs !== undefined) fields['Quarter lbs'] = body.quarter_lbs;
    if (body.quarter_payment_link !== undefined) fields['Quarter Payment Link'] = body.quarter_payment_link;
    if (body.half_price !== undefined) fields['Half Price'] = body.half_price ? parseFloat(body.half_price) : null;
    if (body.half_lbs !== undefined) fields['Half lbs'] = body.half_lbs;
    if (body.half_payment_link !== undefined) fields['Half Payment Link'] = body.half_payment_link;
    if (body.whole_price !== undefined) fields['Whole Price'] = body.whole_price ? parseFloat(body.whole_price) : null;
    if (body.whole_lbs !== undefined) fields['Whole lbs'] = body.whole_lbs;
    if (body.whole_payment_link !== undefined) fields['Whole Payment Link'] = body.whole_payment_link;
    if (body.next_processing_date !== undefined) fields['Next Processing Date'] = body.next_processing_date || null;
    if (body.reserve_link !== undefined) fields['Reserve Link'] = body.reserve_link;
    if (body.testimonials !== undefined) fields['Testimonials'] = body.testimonials;
    if (body.gallery_photos !== undefined) fields['Gallery Photos'] = body.gallery_photos;
    if (body.custom_products !== undefined) fields['Custom Products'] = body.custom_products;
    if (body.google_reviews_url !== undefined) fields['Google Reviews URL'] = body.google_reviews_url;
    if (body.facebook_url !== undefined) fields['Facebook URL'] = body.facebook_url;
    if (body.instagram_url !== undefined) fields['Instagram URL'] = body.instagram_url;
    if (body.processing_facility !== undefined) fields['Processing Facility'] = body.processing_facility;
    if (body.verification_method !== undefined) fields['Verification Method'] = body.verification_method;
    if (body.verification_notes !== undefined) fields['Verification Notes'] = body.verification_notes;
    if (body.page_live === true) fields['Page Live'] = true;
    else if (body.page_live === false) fields['Page Live'] = false;
    if (body.ships_nationwide === true) fields['Ships Nationwide'] = true;
    else if (body.ships_nationwide === false) fields['Ships Nationwide'] = false;

    let shouldSendApproval = false;
    let shouldSendGoLive = false;
    if (body.status && body.status.toLowerCase() === 'approved') {
      try {
        const current: any = await getRecordById(TABLES.RANCHERS, id);
        const currentStatus = (current['Status'] || '').toLowerCase();
        if (currentStatus !== 'approved') {
          shouldSendApproval = true;
        }
      } catch { /* proceed */ }
    }
    if (body.onboarding_status === 'Live' && (body.active_status === 'Active' || fields['Active Status'] === 'Active')) {
      try {
        const current: any = await getRecordById(TABLES.RANCHERS, id);
        const currentOnboarding = (current['Onboarding Status'] || '').trim();
        if (currentOnboarding !== 'Live') {
          shouldSendGoLive = true;
        }
      } catch { /* proceed */ }
    }

    // Re-geocode when Zip / City / State changes so the map pin stays accurate.
    // ZIP-first for ~3-5 mi precision; falls back to city centroid. Non-fatal —
    // field updates proceed even if geocoding fails. Mirrors setup/route.ts:370-403.
    const locationChanged = 'Zip' in fields || 'City' in fields || 'State' in fields;
    if (locationChanged) {
      try {
        const current: any = await getRecordById(TABLES.RANCHERS, id);
        const zip = ('Zip' in fields ? String(fields['Zip'] || '') : String(current?.['Zip'] || ''))
          .trim().slice(0, 5);
        const city = 'City' in fields
          ? String(fields['City'] || '')
          : String(current?.['City'] || '');
        const state = 'State' in fields
          ? String(fields['State'] || '')
          : String(current?.['State'] || '');
        const coords = await geocodeRancher({ zip, city, state });
        if (coords) {
          fields['Latitude'] = coords.lat;
          fields['Longitude'] = coords.lng;
        }
      } catch (e: any) {
        // Non-fatal — keep field updates, skip lat/lng refresh.
        console.warn('[admin-rancher-patch] re-geocode skipped:', e?.message);
      }
    }

    // P1 audit D-3: capture pre-state for reversible audit log
    let prevRancher: any = null;
    try { prevRancher = await getRecordById(TABLES.RANCHERS, id); } catch { /* non-fatal */ }

    const updatedRecord = await updateRecord(TABLES.RANCHERS, id, fields);

    // Audit log: any admin PATCH on a rancher record is a tracked mutation.
    // Stores the prior values of every field we touched so a Telegram undo
    // card can restore on misclick. Non-fatal — bare-minimum coverage > none.
    try {
      const reverseFields: Record<string, unknown> = {};
      if (prevRancher) {
        for (const key of Object.keys(fields)) {
          reverseFields[key] = prevRancher[key] !== undefined ? prevRancher[key] : null;
        }
      }
      await logAuditEntry({
        actor: 'manual',
        tool: 'admin-rancher-patch',
        targetType: 'Rancher',
        targetId: id,
        args: { fieldsChanged: Object.keys(fields) },
        result: { ok: true },
        reverseAction: prevRancher
          ? buildAirtableUpdateReverse(TABLES.RANCHERS, id, reverseFields)
          : { type: 'noop', reason: 'pre-state unavailable' },
      });
    } catch (e: any) {
      console.error('[admin-rancher-patch] audit log failed (non-fatal):', e?.message);
    }

    // F8 audit: if THIS PATCH transitions the rancher to Live + Active in one
    // shot, fire launch-warmup immediately. Pre-fix, manual admin flips waited
    // up to 24h for the daily cron — buyers in this rancher's state stayed
    // un-warmed. Gate on previous-state != live so we don't re-fire on every
    // PATCH that mentions both fields. Idempotent on the cron side anyway.
    const willGoLive = body.onboarding_status === 'Live' &&
      (body.active_status === 'Active' || fields['Active Status'] === 'Active');
    const wasAlreadyLive = prevRancher
      ? (prevRancher['Onboarding Status'] || '').trim() === 'Live' &&
        (prevRancher['Active Status'] || '').trim() === 'Active'
      : false;
    if (willGoLive && !wasAlreadyLive) {
      triggerLaunchWarmup(`admin-rancher-patch:${id}`);
    }

    if (shouldSendApproval) {
      try {
        const rancher: any = await getRecordById(TABLES.RANCHERS, id);
        const email = rancher['Email'];
        const operatorName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Partner';
        const ranchName = rancher['Ranch Name'] || '';

        if (email) {
          await sendRancherApproval({ operatorName, ranchName, email });
        }
      } catch (emailErr) {
        console.error('Failed to send rancher approval email (non-fatal):', emailErr);
      }
    }

    if (shouldSendGoLive) {
      try {
        const rancher: any = await getRecordById(TABLES.RANCHERS, id);
        const email = rancher['Email'];
        const operatorName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Partner';
        const ranchName = rancher['Ranch Name'] || '';
        const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

        if (email) {
          await sendRancherGoLiveEmail({
            operatorName,
            ranchName,
            email,
            dashboardUrl: `${baseUrl}/rancher`,
          });
        }
      } catch (emailErr) {
        console.error('Failed to send rancher go-live email (non-fatal):', emailErr);
      }
    }

    return NextResponse.json(updatedRecord);
  } catch (error: any) {
    console.error('API error updating rancher:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;
    const { id } = await context.params;

    // Audit log: capture full record before delete so a future undo can
    // re-create it. delete-reversal not implemented yet but the args
    // payload preserves the data for a manual restore.
    let prevRancher: any = null;
    try { prevRancher = await getRecordById(TABLES.RANCHERS, id); } catch { /* non-fatal */ }

    await deleteRecord(TABLES.RANCHERS, id);

    try {
      await logAuditEntry({
        actor: 'manual',
        tool: 'admin-rancher-delete',
        targetType: 'Rancher',
        targetId: id,
        args: { rancherId: id, snapshot: prevRancher || null },
        result: { ok: true },
        reverseAction: { type: 'noop', reason: 'delete reversal requires manual restore from snapshot in Args' },
      });
    } catch (e: any) {
      console.error('[admin-rancher-delete] audit log failed (non-fatal):', e?.message);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('API error deleting rancher:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
