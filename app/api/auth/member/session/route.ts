import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveBuyerSession } from '@/lib/buyerAuth';

const MEMBER_AUTH_COOKIE = 'bhc-member-auth';

export async function GET(request: Request) {
  try {
    // Auth Phase 1: resolveBuyerSession transparently picks Clerk or
    // legacy JWT based on CLERK_BUYER_ENABLED. Same return shape either way.
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

// DELETE — buyer-side logout. Clears the legacy bhc-member-auth cookie.
// Note: under Clerk path, the Clerk session is cleared via the Clerk
// client-side sign-out flow (the SignOutButton component) — this endpoint
// is a no-op in that case but still safe to call (idempotent delete).
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
