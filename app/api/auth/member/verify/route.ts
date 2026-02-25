import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const MEMBER_AUTH_COOKIE = 'bhc-member-auth';

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

    if (decoded.type !== 'member-login') {
      return NextResponse.json({ error: 'Invalid token type' }, { status: 401 });
    }

    const consumer = await getRecordById(TABLES.CONSUMERS, decoded.consumerId) as any;
    if (!consumer) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const status = consumer['Status'] || '';
    if (status !== 'Approved' && status !== 'Active') {
      return NextResponse.json({ error: 'Your account is not yet approved. Please wait for admin review.' }, { status: 403 });
    }

    const sessionToken = jwt.sign(
      {
        type: 'member-session',
        consumerId: consumer.id,
        email: decoded.email,
        name: consumer['Full Name'] || '',
        state: consumer['State'] || '',
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    const cookieStore = await cookies();
    cookieStore.set(MEMBER_AUTH_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: '/',
    });

    return NextResponse.json({
      success: true,
      member: {
        id: consumer.id,
        name: consumer['Full Name'] || '',
        email: decoded.email,
        state: consumer['State'] || '',
      },
    });
  } catch (error: any) {
    console.error('Member verify error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
