import { NextResponse } from 'next/server';
import { getRecordById, TABLES } from '@/lib/airtable';
import { refreshAccessToken, persistRancherTokens } from '@/lib/cal';
import { resolveRancherSession } from '@/lib/rancherAuth';

// GET /api/auth/cal/refresh
//
// Called by @calcom/atoms CalProvider when its in-memory access token
// expires. Returns { accessToken } so the SDK can keep going. Uses the
// signed-in rancher's stored refresh token to mint a fresh pair, persists
// both halves, returns just the new access token to the client.
//
// Cal v2 rotates refresh tokens on every refresh — both halves must be
// stored. callCalApi() does this via persistRancherTokens(); this
// endpoint mirrors the same pattern for the client-side SDK.

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const r = await resolveRancherSession(req);
  if (!r) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let rancher: any;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, r.rancherId);
  } catch {
    return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
  }
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  const refreshToken = String(rancher['Cal OAuth Refresh Token'] || '');
  if (!refreshToken) {
    return NextResponse.json({ error: 'No refresh token — re-authorize required' }, { status: 412 });
  }

  try {
    const fresh = await refreshAccessToken(refreshToken);
    await persistRancherTokens(r.rancherId, fresh);
    return NextResponse.json({ accessToken: fresh.access_token });
  } catch (e: any) {
    console.error('[auth/cal/refresh] refresh failed:', e?.message);
    return NextResponse.json(
      { error: 'Refresh failed — re-authorize required', detail: e?.message },
      { status: 502 },
    );
  }
}
