import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { auth as clerkAuth, clerkClient } from '@clerk/nextjs/server';
import { resolveBuyerSession, CLERK_BUYER_ENABLED } from '@/lib/buyerAuth';

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

// DELETE — buyer-side logout. Clears the legacy bhc-member-auth cookie
// AND server-side revokes the Clerk session (when CLERK_BUYER_ENABLED).
// Without the Clerk revocation, calling DELETE under Clerk would lie:
// the legacy cookie deletion is a no-op (it isn't being used) and the
// Clerk session cookie persists, so the next GET returns authenticated.
// Revoking the session server-side guarantees the next request sees
// "not authenticated" regardless of which path is active.
export async function DELETE() {
  try {
    const cookieStore = await cookies();
    cookieStore.delete(MEMBER_AUTH_COOKIE);

    if (CLERK_BUYER_ENABLED) {
      try {
        const session = await clerkAuth();
        if (session.sessionId) {
          const client = await clerkClient();
          await client.sessions.revokeSession(session.sessionId);
        }
      } catch (e: any) {
        // Clerk revoke is best-effort. Legacy cookie is already deleted,
        // so worst case the client still has a valid Clerk session that
        // its own UI should clear via Clerk's SignOutButton.
        console.warn('[member logout] Clerk session revoke failed:', e?.message);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Member logout error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
