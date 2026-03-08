import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const AFFILIATE_AUTH_COOKIE = 'bhc-affiliate-auth';

export async function GET() {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get(AFFILIATE_AUTH_COOKIE);

    if (!sessionCookie?.value) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(sessionCookie.value, JWT_SECRET);
    } catch {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    if (decoded.type !== 'affiliate-session') {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    return NextResponse.json({
      authenticated: true,
      affiliate: {
        id: decoded.affiliateId,
        name: decoded.name,
        email: decoded.email,
        code: decoded.code,
      },
    });
  } catch (error: any) {
    console.error('Affiliate session error:', error);
    return NextResponse.json({ authenticated: false }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const cookieStore = await cookies();
    cookieStore.delete(AFFILIATE_AUTH_COOKIE);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Affiliate logout error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
