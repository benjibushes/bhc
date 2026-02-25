import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const MEMBER_AUTH_COOKIE = 'bhc-member-auth';

export async function GET() {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get(MEMBER_AUTH_COOKIE);

    if (!sessionCookie?.value) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(sessionCookie.value, JWT_SECRET);
    } catch {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    if (decoded.type !== 'member-session') {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    return NextResponse.json({
      authenticated: true,
      member: {
        id: decoded.consumerId,
        name: decoded.name,
        email: decoded.email,
        state: decoded.state,
      },
    });
  } catch (error: any) {
    console.error('Member session error:', error);
    return NextResponse.json({ authenticated: false }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const cookieStore = await cookies();
    cookieStore.delete(MEMBER_AUTH_COOKIE);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Member logout error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
