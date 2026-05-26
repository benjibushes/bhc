// Rancher session GET + DELETE.
//
// Auth Phase 2: GET reads through `resolveRancherSession` so Clerk and
// legacy JWT both produce the same response shape. DELETE clears the
// legacy `bhc-rancher-auth` cookie AND, when the flag is on, revokes
// the active Clerk session server-side so a stale Clerk cookie doesn't
// quietly keep the rancher signed in after they hit "Log out".

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { auth as clerkAuth, clerkClient } from '@clerk/nextjs/server';
import {
  resolveRancherSession,
  CLERK_RANCHER_ENABLED,
} from '@/lib/rancherAuth';

const RANCHER_AUTH_COOKIE = 'bhc-rancher-auth';

export async function GET(request: Request) {
  try {
    const session = await resolveRancherSession(request);
    if (!session) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }
    return NextResponse.json({
      authenticated: true,
      rancher: {
        id: session.rancherId,
        name: session.name,
        ranchName: session.ranchName,
        email: session.email,
        state: session.state,
      },
      // Surface admin impersonation flag so the dashboard can show
      // admin-only controls (e.g. "Revive Lead" on Closed Lost
      // referrals). Set by /api/admin/ranchers/[id]/impersonate when
      // the legacy JWT is minted. Always null under Clerk.
      impersonatedBy: session.impersonatedBy ?? null,
    });
  } catch (error: any) {
    console.error('Rancher session error:', error);
    return NextResponse.json({ authenticated: false }, { status: 500 });
  }
}

// DELETE — rancher-side logout. Clears the legacy bhc-rancher-auth
// cookie AND server-side revokes the Clerk session (when
// CLERK_RANCHER_ENABLED). Without the Clerk revocation, calling DELETE
// under Clerk would lie: the legacy cookie deletion is a no-op (it
// isn't being used) and the Clerk session cookie persists, so the next
// GET returns authenticated. Revoking the session server-side
// guarantees the next request sees "not authenticated" regardless of
// which path is active.
export async function DELETE() {
  try {
    const cookieStore = await cookies();
    cookieStore.delete(RANCHER_AUTH_COOKIE);

    if (CLERK_RANCHER_ENABLED) {
      try {
        const session = await clerkAuth();
        if (session.sessionId) {
          const client = await clerkClient();
          await client.sessions.revokeSession(session.sessionId);
        }
      } catch (e: any) {
        // Clerk revoke is best-effort. Legacy cookie is already
        // deleted, so worst case the client still has a valid Clerk
        // session that its own UI should clear via Clerk's
        // SignOutButton.
        console.warn('[rancher logout] Clerk session revoke failed:', e?.message);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Rancher logout error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
