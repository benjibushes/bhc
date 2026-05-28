// Rancher session GET + DELETE.
//
// GET reads through `resolveRancherSession` so callers see a uniform
// session shape. DELETE clears the bhc-rancher-auth cookie.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveRancherSession } from '@/lib/rancherAuth';

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
      // the legacy JWT is minted.
      impersonatedBy: session.impersonatedBy ?? null,
    });
  } catch (error: any) {
    console.error('Rancher session error:', error);
    return NextResponse.json({ authenticated: false }, { status: 500 });
  }
}

// DELETE — rancher-side logout. Clears the bhc-rancher-auth cookie.
export async function DELETE() {
  try {
    const cookieStore = await cookies();
    cookieStore.delete(RANCHER_AUTH_COOKIE);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Rancher logout error:', error);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
