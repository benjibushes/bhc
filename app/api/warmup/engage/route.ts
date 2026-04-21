import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

// GET /api/warmup/engage?token=...
// Marks a waitlisted buyer as engaged with the rancher launch-warmup email,
// then redirects to a confirmation page. Token is a signed JWT so the link
// can't be enumerated.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token');

    if (!token) {
      return NextResponse.redirect(`${SITE_URL}/access?error=missing-token`);
    }

    let payload: any;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return NextResponse.redirect(`${SITE_URL}/access?error=expired-token`);
    }

    if (payload.type !== 'warmup-engage' || !payload.consumerId) {
      return NextResponse.redirect(`${SITE_URL}/access?error=bad-token`);
    }

    const consumer: any = await getRecordById(TABLES.CONSUMERS, payload.consumerId);
    if (!consumer) {
      return NextResponse.redirect(`${SITE_URL}/access?error=not-found`);
    }

    if (!consumer['Warmup Engaged At']) {
      await updateRecord(TABLES.CONSUMERS, payload.consumerId, {
        'Warmup Engaged At': new Date().toISOString(),
        'Warmup Stage': 'engaged',
      });
    }

    return NextResponse.redirect(`${SITE_URL}/access?warmup=engaged`);
  } catch (error: any) {
    console.error('Warmup engage error:', error);
    return NextResponse.redirect(`${SITE_URL}/access?error=server`);
  }
}
