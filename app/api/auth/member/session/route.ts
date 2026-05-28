import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveBuyerSession } from '@/lib/buyerAuth';

const MEMBER_AUTH_COOKIE = 'bhc-member-auth';

export async function GET(request: Request) {
  try {
    const session = await resolveBuyerSession(request);
    if (!session) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    return NextResponse.json({
      authenticated: true,
      member: {
        id: session.consumerId,
        name: session.name,
        email: session.email,
        state: session.state,
      },
    });
  } catch (error: any) {
    console.error('Member session error:', error);
    return NextResponse.json({ authenticated: false }, { status: 500 });
  }
}

// DELETE — buyer-side logout. Clears the bhc-member-auth cookie.
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
