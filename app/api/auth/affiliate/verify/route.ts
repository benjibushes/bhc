import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const AFFILIATE_AUTH_COOKIE = 'bhc-affiliate-auth';

export async function POST(request: Request) {
  try {
    const { token } = await request.json();

    if (!token) {
      return NextResponse.json({ error: 'Token is required' }, { status: 400 });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return NextResponse.json({ error: 'Invalid or expired link. Please request a new one.' }, { status: 401 });
    }

    if (decoded.type !== 'affiliate-login') {
      return NextResponse.json({ error: 'Invalid token type' }, { status: 401 });
    }

    const affiliate = await getRecordById(TABLES.AFFILIATES, decoded.affiliateId) as any;
    if (!affiliate) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const status = (affiliate['Status'] || '').toLowerCase();
    if (status !== 'active') {
      return NextResponse.json({ error: 'Your affiliate account is not active. Contact support.' }, { status: 403 });
    }

    const sessionToken = jwt.sign(
      {
        type: 'affiliate-session',
        affiliateId: affiliate.id,
        email: decoded.email,
        name: affiliate['Name'] || '',
        code: affiliate['Code'] || '',
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    const cookieStore = await cookies();
    cookieStore.set(AFFILIATE_AUTH_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: '/',
    });

    return NextResponse.json({
      success: true,
      affiliate: {
        id: affiliate.id,
        name: affiliate['Name'] || '',
        email: decoded.email,
        code: affiliate['Code'] || '',
      },
    });
  } catch (error: any) {
    console.error('Affiliate verify error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
