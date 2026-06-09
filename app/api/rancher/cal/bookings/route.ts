import { NextResponse } from 'next/server';
import { getRecordById, TABLES } from '@/lib/airtable';
import { listCalBookings } from '@/lib/cal';
import { resolveRancherSession } from '@/lib/rancherAuth';

// GET /api/rancher/cal/bookings?status=upcoming|past|cancelled&take=20
//
// Returns the signed-in rancher's bookings, live from Cal's API. Used by
// the dashboard "Bookings" panel + the rancher-page widget. Cached for
// 30s on the response — Cal's API is fast but if the dashboard polls
// every few seconds we want to avoid burning the token budget.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ALLOWED_STATUS = new Set(['upcoming', 'past', 'cancelled']);

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

  const accessToken = String(rancher['Cal OAuth Access Token'] || '');
  if (!accessToken) {
    return NextResponse.json({ error: 'Cal not connected', state: 'disconnected' }, { status: 412 });
  }

  const url = new URL(req.url);
  const statusRaw = url.searchParams.get('status') || 'upcoming';
  const status: 'upcoming' | 'past' | 'cancelled' = ALLOWED_STATUS.has(statusRaw)
    ? (statusRaw as 'upcoming' | 'past' | 'cancelled')
    : 'upcoming';
  const take = Math.min(100, Math.max(1, Number(url.searchParams.get('take') || '20')));

  try {
    const bookings = await listCalBookings({ rancher, status, take });
    return NextResponse.json(
      { bookings },
      {
        headers: {
          'Cache-Control': 'private, max-age=30, stale-while-revalidate=120',
        },
      },
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'Cal API error', bookings: [] },
      { status: 502 },
    );
  }
}
