import { NextResponse } from 'next/server';
import { buildAuthorizationUrl } from '@/lib/cal';
import { resolveRancherSession } from '@/lib/rancherAuth';

// GET /api/auth/cal/start
//
// Starts the Cal.com OAuth flow for the authenticated rancher. Mints a
// signed `state` JWT containing the rancherId so the callback can
// re-identify them after Cal redirects back.
//
// Authenticated via the same `bhc-rancher-auth` cookie the dashboard uses
// — so the wizard "Connect Cal" button can just <a href> here. No
// rancherId in the URL — that'd be a trivially-spoofable user-switch
// hole. Session cookie is the source of truth.
//
// Pending OAuth client approval: Cal will display "this client is pending
// approval" on its authorization page until a Cal admin clears it. The
// flow still works — just the rancher will see Cal's message until
// approval lands.

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const r = await resolveRancherSession(req);
  if (!r) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  try {
    const url = buildAuthorizationUrl({ rancherId: r.rancherId });
    return NextResponse.redirect(url);
  } catch (e: any) {
    console.error('[auth/cal/start] buildAuthorizationUrl failed:', e?.message);
    return NextResponse.json(
      { error: 'Cal OAuth not configured — set CAL_OAUTH_CLIENT_ID env' },
      { status: 503 },
    );
  }
}
