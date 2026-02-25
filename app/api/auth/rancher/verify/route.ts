import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const RANCHER_AUTH_COOKIE = 'bhc-rancher-auth';

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

    if (decoded.type !== 'rancher-login') {
      return NextResponse.json({ error: 'Invalid token type' }, { status: 401 });
    }

    const rancher = await getRecordById(TABLES.RANCHERS, decoded.rancherId) as any;
    if (!rancher) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const sessionToken = jwt.sign(
      {
        type: 'rancher-session',
        rancherId: rancher.id,
        email: decoded.email,
        name: rancher['Operator Name'] || rancher['Ranch Name'] || '',
        ranchName: rancher['Ranch Name'] || '',
        state: rancher['State'] || '',
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    const cookieStore = await cookies();
    cookieStore.set(RANCHER_AUTH_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
    });

    return NextResponse.json({
      success: true,
      rancher: {
        id: rancher.id,
        name: rancher['Operator Name'] || '',
        ranchName: rancher['Ranch Name'] || '',
        email: decoded.email,
        state: rancher['State'] || '',
      },
    });
  } catch (error: any) {
    console.error('Rancher verify error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
