// app/api/admin/cal/bookings/route.ts
//
// Sales-floor closed-loop v3: returns Ben's upcoming Cal bookings inline
// so /admin/today/v2 can render rich call cards (attendee info, join link,
// quiz score chip, time-until-call) without iframing Cal.
//
// Uses CAL_API_KEY (operator-level key already set in env) to call Cal v2
// /bookings endpoint. Filtered to upcoming (next 7 days) + status accepted.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CAL_API_BASE = 'https://api.cal.com/v2';
const CAL_API_VERSION = '2024-08-13';

export async function GET(req: Request) {
  const a = await requireAdmin(req);
  if (a) return a;

  const apiKey = process.env.CAL_API_KEY || '';
  if (!apiKey) {
    return NextResponse.json({ bookings: [], note: 'CAL_API_KEY not set' });
  }

  const start = new Date();
  const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  try {
    const url = new URL(`${CAL_API_BASE}/bookings`);
    url.searchParams.set('status', 'accepted');
    url.searchParams.set('take', '50');
    url.searchParams.set('afterStart', start.toISOString());
    url.searchParams.set('beforeEnd', end.toISOString());

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'cal-api-version': CAL_API_VERSION,
      },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return NextResponse.json({ bookings: [], error: `Cal ${res.status}: ${txt.slice(0, 200)}` });
    }
    const json = await res.json();
    const data = json?.data?.bookings || json?.bookings || json?.data || [];
    return NextResponse.json({ bookings: data.map(formatBooking) });
  } catch (e: any) {
    return NextResponse.json({ bookings: [], error: e?.message || 'fetch failed' });
  }
}

function formatBooking(b: any) {
  const attendees = b.attendees || b.attendeesList || [];
  const firstAttendee = attendees[0] || {};
  return {
    id: String(b.id || b.uid || ''),
    uid: String(b.uid || b.id || ''),
    title: String(b.title || b.eventType?.title || 'Sales call'),
    startTime: String(b.start || b.startTime || ''),
    endTime: String(b.end || b.endTime || ''),
    duration: Number(b.duration || 0),
    status: String(b.status || ''),
    attendeeName: String(firstAttendee.name || ''),
    attendeeEmail: String(firstAttendee.email || ''),
    attendeeTimeZone: String(firstAttendee.timeZone || ''),
    meetingUrl: String(b.meetingUrl || b.location || ''),
    rescheduleUrl: String(b.rescheduleUrl || b.absoluteRescheduleUrl || ''),
    cancelUrl: String(b.cancelUrl || b.absoluteCancelUrl || ''),
    metadata: b.metadata || {},
  };
}
