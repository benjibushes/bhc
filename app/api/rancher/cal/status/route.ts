import { NextResponse } from 'next/server';
import { getRecordById, TABLES } from '@/lib/airtable';
import { getCalConnectionStatus } from '@/lib/cal';
import { resolveRancherSession } from '@/lib/rancherAuth';

// GET /api/rancher/cal/status
//
// Rancher-dashboard endpoint. Returns the current Cal connection state
// for the signed-in rancher. The dashboard CTA cascades on this:
//
//   - disconnected → "Connect your Cal account" CTA → /api/auth/cal/start
//   - expired      → "Re-authorize Cal" CTA → /api/auth/cal/start
//   - error        → "Something's off — reconnect" CTA → /api/auth/cal/start
//   - connected    → show "Cal connected as @<username>" + Disconnect button
//
// Does NOT mutate. Calls /me on the rancher's Cal account to verify
// the token actually works — catches the case where a token row exists
// but has been revoked Cal-side.

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

  const status = await getCalConnectionStatus(rancher);
  return NextResponse.json({
    ...status,
    introEventTypeId: rancher['Cal Event Type Intro Id'] || null,
    salesEventTypeId: rancher['Cal Event Type Sales Id'] || null,
    webhookId: rancher['Cal Webhook Id'] || null,
  });
}
