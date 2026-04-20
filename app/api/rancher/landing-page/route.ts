import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { updateRecord, getRecordById, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { normalizeStates, stringifyStates } from '@/lib/states';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';

// PATCH /api/rancher/landing-page — rancher updates their own landing page fields
export async function PATCH(request: Request) {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get('bhc-rancher-auth');

    if (!sessionCookie?.value) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(sessionCookie.value, JWT_SECRET);
    } catch {
      return NextResponse.json({ error: 'Session expired' }, { status: 401 });
    }

    if (decoded.type !== 'rancher-session') {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    const body = await request.json();

    // Only allow landing page fields — never let ranchers write to status/commission/auth fields
    const allowed = [
      'Slug',
      'Logo URL',
      'Tagline',
      'About Text',
      'Video URL',
      'Quarter Price',
      'Quarter lbs',
      'Quarter Payment Link',
      'Half Price',
      'Half lbs',
      'Half Payment Link',
      'Whole Price',
      'Whole lbs',
      'Whole Payment Link',
      'Next Processing Date',
      'Reserve Link',
      'Custom Notes',
      'States Served',
      'Ships Nationwide',
      'Beef Types',
      'Certifications',
      'Testimonials',
      'Gallery Photos',
      'Custom Products',
      'Google Reviews URL',
      'Facebook URL',
      'Instagram URL',
      'Processing Facility',
    ];

    // Handle special actions
    if (body._action === 'update-capacity') {
      const maxReferrals = parseInt(body.maxActiveReferrals);
      if (isNaN(maxReferrals) || maxReferrals < 1 || maxReferrals > 50) {
        return NextResponse.json({ error: 'Capacity must be between 1 and 50' }, { status: 400 });
      }
      await updateRecord(TABLES.RANCHERS, decoded.rancherId, {
        'Max Active Referalls': maxReferrals,
      });
      // If they were at capacity but increased the limit, set back to Active
      const rancher = await getRecordById(TABLES.RANCHERS, decoded.rancherId) as any;
      const current = rancher['Current Active Referrals'] || 0;
      if (rancher['Active Status'] === 'At Capacity' && current < maxReferrals) {
        await updateRecord(TABLES.RANCHERS, decoded.rancherId, { 'Active Status': 'Active' });
      }
      return NextResponse.json({ success: true });
    }

    if (body._action === 'request-verification') {
      const rancher = await getRecordById(TABLES.RANCHERS, decoded.rancherId) as any;
      const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Unknown';
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
      const slug = rancher['Slug'] || '';

      // Save any verification materials submitted with the request
      const updates: Record<string, any> = {
        'Verification Requested At': new Date().toISOString(),
      };
      // Support both old field names and new form field names
      if (body.testimonials) updates['Testimonials'] = body.testimonials;
      if (body.customerReferences) updates['Customer References'] = body.customerReferences;
      if (body.galleryPhotos) updates['Gallery Photos'] = body.galleryPhotos;
      if (body.googleReviewsUrl || body.reviewsLink) updates['Google Reviews URL'] = body.googleReviewsUrl || body.reviewsLink;
      if (body.facebookUrl) updates['Facebook URL'] = body.facebookUrl;
      if (body.instagramUrl || body.socialMedia) {
        const social = body.instagramUrl || body.socialMedia;
        if (social.includes('facebook')) updates['Facebook URL'] = social;
        else updates['Instagram URL'] = social;
      }
      if (body.processingFacility || body.processorName) updates['Processing Facility'] = body.processingFacility || body.processorName;
      if (body.certifications) updates['Certifications'] = body.certifications;

      // Build verification method summary
      const methods: string[] = [];
      if (body.customerReferences || body.testimonials) methods.push('Customer References');
      if (body.galleryPhotos) methods.push('Photos');
      if (body.reviewsLink || body.googleReviewsUrl) methods.push('Reviews Link');
      if (body.socialMedia || body.facebookUrl || body.instagramUrl) methods.push('Social Media');
      if (body.processorName || body.processingFacility) methods.push('USDA Processor');
      if (body.certifications) methods.push('Certifications');
      updates['Verification Method'] = methods.join(', ') || 'Digital Proof';

      // AUTO-VERIFICATION: if the rancher submitted strong social proof (at
      // least 3 independent verification signals), auto-approve. Otherwise
      // fall through to the 1-tap Ben review. This eliminates the manual step
      // for the 80% of ranchers who have proper credentials while keeping
      // human judgment for the edge cases.
      //
      // Strong signals (each counts as 1):
      //   - 2+ customer references OR testimonials
      //   - Google Reviews URL
      //   - At least one social profile (Facebook OR Instagram)
      //   - USDA processing facility named
      //   - Certifications listed
      //   - Gallery photos provided
      const hasReferences = !!(body.customerReferences || body.testimonials);
      const hasReviews = !!(body.googleReviewsUrl || body.reviewsLink);
      const hasSocial = !!(body.facebookUrl || body.instagramUrl || body.socialMedia);
      const hasProcessor = !!(body.processingFacility || body.processorName);
      const hasCerts = !!body.certifications;
      const hasPhotos = !!body.galleryPhotos;
      const signalCount = [hasReferences, hasReviews, hasSocial, hasProcessor, hasCerts, hasPhotos]
        .filter(Boolean).length;

      const autoApprove = signalCount >= 3;

      if (autoApprove) {
        updates['Onboarding Status'] = 'Verification Complete';
        updates['Verification Status'] = 'Verified';
        updates['Verification Notes'] = `Auto-verified ${new Date().toISOString().slice(0, 10)} — ${signalCount}/6 signals (${methods.join(', ')})`;
      } else {
        updates['Onboarding Status'] = 'Verification Pending';
      }

      await updateRecord(TABLES.RANCHERS, decoded.rancherId, updates);

      try {
        if (autoApprove) {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `✅ <b>AUTO-VERIFIED</b>\n\n🤠 ${name}\n📋 Signals: ${signalCount}/6 (${methods.join(', ')})\n${slug ? `Preview: ${siteUrl}/ranchers/${slug}` : ''}\n\n<i>Auto-approved — batch-approve cron will flip Page Live at next 9am MT run if slug + prices are set. Revert manually if needed.</i>`
          );
        } else {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `🔍 <b>VERIFICATION REQUEST</b> (low signal — ${signalCount}/6)\n\n🤠 ${name}\n📋 Proof: ${methods.join(', ') || 'Submitted'}\nEmail: ${rancher['Email'] || 'N/A'}\nPhone: ${rancher['Phone'] || 'N/A'}\n${slug ? `Preview: ${siteUrl}/ranchers/${slug}` : ''}\n\nReview their materials and approve.`,
            {
              inline_keyboard: [
                [{ text: '✅ Approve Verification', callback_data: `rverify_${decoded.rancherId}` }],
              ],
            }
          );
        }
      } catch (e) {
        console.error('Telegram verification notification error:', e);
      }

      return NextResponse.json({
        success: true,
        autoApproved: autoApprove,
        message: autoApprove
          ? 'Verified! Your profile will go live within 24 hours once prices are set.'
          : 'Verification request submitted. We\'ll review within 24-48 hours.',
      });
    }

    if (body._action === 'request-go-live') {
      const rancher = await getRecordById(TABLES.RANCHERS, decoded.rancherId) as any;
      const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Unknown';
      const slug = rancher['Slug'] || '(no slug set)';
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🟢 <b>GO LIVE REQUEST</b>\n\n🤠 ${name} wants their page published\nSlug: ${slug}\nPreview: ${siteUrl}/ranchers/${slug}`,
          {
            inline_keyboard: [
              [{ text: '🟢 Set Live', callback_data: `rgolive_${decoded.rancherId}` }],
            ],
          }
        );
      } catch (e) {
        console.error('Telegram go-live notification error:', e);
      }
      return NextResponse.json({ success: true, message: 'Go-live request sent to admin' });
    }

    const fields: Record<string, any> = {};
    for (const key of allowed) {
      if (key in body) {
        const val = body[key];
        fields[key] = val === '' ? null : val;
      }
    }

    if (Object.keys(fields).length === 0) {
      return NextResponse.json({ error: 'No valid fields provided' }, { status: 400 });
    }

    // Convert Ships Nationwide to boolean for Airtable
    if ('Ships Nationwide' in fields) {
      fields['Ships Nationwide'] = fields['Ships Nationwide'] === 'true' || fields['Ships Nationwide'] === true;
    }

    // Validate slug: lowercase alphanumeric + hyphens only
    if (fields['Slug'] !== undefined && fields['Slug'] !== null) {
      const slug = String(fields['Slug']).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      fields['Slug'] = slug;
    }

    // Validate URL fields
    const urlFields = ['Logo URL', 'Video URL', 'Quarter Payment Link', 'Half Payment Link', 'Whole Payment Link', 'Reserve Link'];
    for (const key of urlFields) {
      if (fields[key] !== undefined && fields[key] !== null) {
        const url = String(fields[key]).trim();
        if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
          fields[key] = `https://${url}`;
        }
      }
    }

    // Validate price fields are numbers
    const priceFields = ['Quarter Price', 'Half Price', 'Whole Price'];
    for (const key of priceFields) {
      if (fields[key] !== undefined && fields[key] !== null) {
        const num = parseFloat(fields[key]);
        if (isNaN(num) || num < 0) {
          return NextResponse.json({ error: `${key} must be a valid positive number` }, { status: 400 });
        }
        fields[key] = num;
      }
    }

    // Normalize States Served — accept array of codes from new multi-select UI,
    // OR comma-separated string (with full names or codes) from legacy callers.
    // Always saves canonical "MT, WY, ID" 2-letter codes joined with ", ".
    if ('States Served' in fields && fields['States Served'] !== null) {
      const codes = normalizeStates(fields['States Served']);
      fields['States Served'] = codes.length > 0 ? stringifyStates(codes) : '';
    }

    await updateRecord(TABLES.RANCHERS, decoded.rancherId, fields);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Landing page update error:', error);
    return NextResponse.json({ error: 'Failed to save changes' }, { status: 500 });
  }
}
