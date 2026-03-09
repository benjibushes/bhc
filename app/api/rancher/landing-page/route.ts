import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { updateRecord, TABLES } from '@/lib/airtable';
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
    ];

    const fields: Record<string, any> = {};
    for (const key of allowed) {
      if (key in body) {
        // Convert empty strings to null for URL/number fields, keep text as-is
        const val = body[key];
        fields[key] = val === '' ? null : val;
      }
    }

    if (Object.keys(fields).length === 0) {
      return NextResponse.json({ error: 'No valid fields provided' }, { status: 400 });
    }

    // Validate slug: lowercase alphanumeric + hyphens only
    if (fields['Slug'] !== undefined && fields['Slug'] !== null) {
      const slug = String(fields['Slug']).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      fields['Slug'] = slug;
    }

    await updateRecord(TABLES.RANCHERS, decoded.rancherId, fields);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Landing page update error:', error);
    return NextResponse.json({ error: 'Failed to save changes' }, { status: 500 });
  }
}
