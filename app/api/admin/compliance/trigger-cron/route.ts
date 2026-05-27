import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { CRON_SECRET } from '@/lib/secrets';

// Server-side proxy for /api/cron/compliance-reminders. Replaces a client-side
// fetch that referenced NEXT_PUBLIC_CRON_SECRET — that env var was baked into
// the client JS bundle on every build, leaking the cron secret to anyone who
// View Source'd /admin/compliance. P0 audit fix (C-1).
//
// Now: admin operator hits this server route (cookie-gated), and we forward
// to the cron route with the Authorization header. CRON_SECRET never leaves
// the server.
export async function POST(request: Request) {
  const authResp = await requireAdmin(request);
  if (authResp) return authResp;

  try {
    // Derive base URL from the incoming request — works in dev, preview, and prod.
    const url = new URL(request.url);
    const cronUrl = `${url.origin}/api/cron/compliance-reminders`;

    const cronRes = await fetch(cronUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });

    const data = await cronRes.json().catch(() => ({}));
    if (!cronRes.ok) {
      return NextResponse.json(
        { error: 'Cron trigger failed', status: cronRes.status, detail: data },
        { status: 502 },
      );
    }

    return NextResponse.json(data);
  } catch (error: any) {
    console.error('admin/compliance/trigger-cron error:', error);
    return NextResponse.json(
      { error: 'Server error', detail: error?.message || 'unknown' },
      { status: 500 },
    );
  }
}
