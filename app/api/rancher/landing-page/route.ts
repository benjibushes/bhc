import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { updateRecord, getRecordById, TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
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
      const method = body.verificationMethod || 'sample'; // 'sample' or 'visit'
      const trackingNumber = body.trackingNumber || '';

      const updates: Record<string, any> = {
        'Onboarding Status': 'Verification Pending',
      };
      if (trackingNumber) {
        updates['Verification Tracking'] = trackingNumber;
      }
      updates['Verification Method'] = method === 'visit' ? 'Ranch Visit' : 'Product Sample';
      updates['Verification Requested At'] = new Date().toISOString();

      await updateRecord(TABLES.RANCHERS, decoded.rancherId, updates);

      const methodText = method === 'visit'
        ? 'Requesting a ranch visit'
        : `Shipping product sample${trackingNumber ? ` (tracking: ${trackingNumber})` : ''}`;

      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🔍 <b>VERIFICATION REQUEST</b>\n\n🤠 ${name}\n📋 Method: ${methodText}\nEmail: ${rancher['Email'] || 'N/A'}\nPhone: ${rancher['Phone'] || 'N/A'}\n\nFollow up to coordinate.`,
          {
            inline_keyboard: [
              [{ text: '✅ Approve Verification', callback_data: `rverify_${decoded.rancherId}` }],
            ],
          }
        );
      } catch (e) {
        console.error('Telegram verification notification error:', e);
      }

      return NextResponse.json({ success: true, message: 'Verification request submitted' });
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

    await updateRecord(TABLES.RANCHERS, decoded.rancherId, fields);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Landing page update error:', error);
    return NextResponse.json({ error: 'Failed to save changes' }, { status: 500 });
  }
}
